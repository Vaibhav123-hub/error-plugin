sap.ui.define([
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"sap/base/Log"
], function (MessageBox, MessageToast, Log) {
	"use strict";

	var STORAGE_KEY = "errorCapturePlugin.queue";
	var UI5_WAIT_INTERVAL_MS = 250;
	var UI5_WAIT_MAX_ATTEMPTS = 120; // give an iframe app ~30s to boot UI5 before giving up on it
	var MAX_BATCH_FAILURES = 10;     // cap rows per $batch response, so one bad batch can't flood the queue

	var _bInitialized = false;
	var _bUnloading = false;
	var _oConfig = {};
	var _aQueue = [];
	var _sCsrfToken = null;
	var _sBackendAbsoluteUrl = "";
	var _aHttpIgnorePatterns = [];
	var _oAppContext = {};
	var _aCleanup = [];
	var _oInstrumentedWindows = new WeakSet();
	var _iFlushIntervalId = null;
	var _iHashChangeTimeoutId = null;
	var _iMessageBoxDepth = 0;
	var _mLastSeen = {}; // error key -> ms timestamp of the last capture, for collapsing one trigger's channels

	function _isCapturedSeverity(sSeverity) {
		return _oConfig.capturedSeverities.indexOf(sSeverity) !== -1;
	}

	// A relative backendBaseUrl (the default) is resolved against the plugin's own resource root, so the
	// request goes through the plugin's approuter routes (xs-app.json) - the plugin runs inside the FLP page,
	// whose own origin/path has no such routes. Absolute ("/..." or "http(s)://...") URLs are used as given.
	function _resolveBackendBaseUrl(sUrl) {
		var sTrimmed = String(sUrl).replace(/\/+$/, "");
		if (sTrimmed.charAt(0) === "/" || /^[a-z][a-z0-9+.-]*:/i.test(sTrimmed)) {
			return sTrimmed;
		}
		return sap.ui.require.toUrl("error/capture/plugin").replace(/\/+$/, "") + "/" + sTrimmed;
	}

	function _toAbsoluteUrl(sUrl, oWin) {
		try {
			return new URL(sUrl, oWin.location.href).href;
		} catch (e) {
			return String(sUrl);
		}
	}

	function _stringifyDetails(vDetails) {
		try {
			return typeof vDetails === "string" ? vDetails : JSON.stringify(vDetails);
		} catch (e) {
			return undefined;
		}
	}

	// ---------------------------------------------------------------------
	// App / tile context (which app on the FLP raised the message)
	// ---------------------------------------------------------------------

	function _parseHash() {
		var oResult = { appId: undefined, tileId: undefined };
		try {
			var sHash = window.location.hash || "";
			var oMatch = /#([^&/?]+)-([^&/?~]+)/.exec(sHash);
			if (oMatch) {
				oResult.appId = oMatch[1] + "-" + oMatch[2];
				oResult.tileId = oResult.appId;
			}
		} catch (e) { /* ignore, best effort */ }
		return oResult;
	}

	function _isStandardApp(sComponentId) {
		if (!sComponentId) { return false; }
		return _oConfig.standardAppNamespacePrefixes.some(function (sPrefix) {
			return sComponentId.indexOf(sPrefix) === 0;
		});
	}

	function _refreshAppContext() {
		var oHashInfo = _parseHash();
		_oAppContext.appId = oHashInfo.appId;
		_oAppContext.tileId = oHashInfo.tileId;
		_oAppContext.appTitle = document.title;

		if (!(window.sap && sap.ushell && sap.ushell.Container && sap.ushell.Container.getServiceAsync)) {
			return;
		}
		sap.ushell.Container.getServiceAsync("AppLifeCycle").then(function (oAppLifeCycle) {
			var oCurrentApp = oAppLifeCycle.getCurrentApplication && oAppLifeCycle.getCurrentApplication();
			var oComponent = oCurrentApp && oCurrentApp.componentInstance;
			if (!oComponent || !oComponent.getManifestEntry) { return; }
			var oAppManifest = oComponent.getManifestEntry("sap.app") || {};
			_oAppContext.appId = oAppManifest.id || _oAppContext.appId;
			_oAppContext.appTitle = (oAppManifest.title && oAppManifest.title.indexOf("{{") !== 0 ? oAppManifest.title : _oAppContext.appTitle) || _oAppContext.appTitle;
			_oAppContext.standardApp = _isStandardApp(oAppManifest.id);
		}).catch(function (oError) {
			Log.warning("Error Capture Plugin: could not resolve current app context", oError);
		});
	}

	function _onHashChange() {
		window.clearTimeout(_iHashChangeTimeoutId);
		// small delay so the new app component/manifest is available once its Component has loaded
		_iHashChangeTimeoutId = window.setTimeout(_refreshAppContext, 400);
	}

	// ---------------------------------------------------------------------
	// Capture + queue + transport
	// ---------------------------------------------------------------------

	// Identifies "the same error" - deliberately without the source, so one failure surfacing as HttpError,
	// MessageBox and message-model entry at once is one error. Must match fingerprint() in srv/error-service.js.
	function _errorKey(oEntry) {
		return [oEntry.severity, oEntry.message, oEntry.messageCode, oEntry.appId, oEntry.tcode, oEntry.program]
			.map(function (v) { return v == null ? "" : String(v).replace(/\s+/g, " ").trim(); })
			.join("\u0001");
	}

	function _capture(mEntry) {
		var sNow = new Date().toISOString();
		var oEntry = Object.assign({
			timestamp: sNow,
			appId: _oAppContext.appId,
			appTitle: _oAppContext.appTitle,
			tileId: _oAppContext.tileId,
			standardApp: !!_oAppContext.standardApp,
			url: window.location.href,
			userAgent: navigator.userAgent
		}, mEntry);

		var sKey = _errorKey(oEntry);
		var iNow = Date.now();
		var iLastSeen = _mLastSeen[sKey];
		_mLastSeen[sKey] = iNow;
		Object.keys(_mLastSeen).forEach(function (sOtherKey) { // keep the map small
			if (iNow - _mLastSeen[sOtherKey] > _oConfig.duplicateWindowMs) { delete _mLastSeen[sOtherKey]; }
		});
		// the same error again within the window is the same trigger reported by another channel - record it once
		if (iLastSeen !== undefined && iNow - iLastSeen <= _oConfig.duplicateWindowMs) {
			return;
		}

		// a genuine repeat that hasn't been sent yet - count it on the queued entry instead of queueing another row
		var oQueued = _aQueue.filter(function (oCandidate) { return _errorKey(oCandidate) === sKey; })[0];
		if (oQueued) {
			oQueued.occurrences = (oQueued.occurrences || 1) + 1;
			oQueued.lastOccurredAt = sNow;
			_persistQueue();
			return;
		}

		oEntry.occurrences = 1;
		oEntry.lastOccurredAt = sNow;
		_aQueue.push(oEntry);
		_persistQueue();

		if (_aQueue.length >= _oConfig.maxQueueLength) {
			_flush();
		}
	}

	function _persistQueue() {
		try {
			var aToStore = _aQueue.slice(-_oConfig.maxStoredOffline);
			window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(aToStore));
		} catch (e) { /* storage may be unavailable (private mode / quota) - queue stays in memory only */ }
	}

	function _restoreQueue() {
		try {
			var sStored = window.sessionStorage.getItem(STORAGE_KEY);
			if (sStored) {
				_aQueue = JSON.parse(sStored).concat(_aQueue);
			}
		} catch (e) { /* ignore corrupt/unavailable storage */ }
	}

	function _ensureCsrfToken() {
		if (_sCsrfToken) { return Promise.resolve(_sCsrfToken); }
		return fetch(_oConfig.backendBaseUrl + "/", {
			method: "GET",
			credentials: "same-origin",
			headers: { "X-CSRF-Token": "Fetch" }
		}).then(function (oResponse) {
			_sCsrfToken = oResponse.headers.get("X-CSRF-Token");
			return _sCsrfToken;
		}).catch(function () {
			return null; // backend may not require CSRF at all (e.g. plain cds-serve) - proceed without it
		});
	}

	function _sendBatch(aBatch) {
		return _ensureCsrfToken().then(function (sToken) {
			var mHeaders = { "Content-Type": "application/json" };
			if (sToken) { mHeaders["X-CSRF-Token"] = sToken; }
			return fetch(_oConfig.backendBaseUrl + "/logErrors", {
				method: "POST",
				credentials: "same-origin",
				keepalive: true,
				headers: mHeaders,
				body: JSON.stringify({ entries: aBatch })
			});
		});
	}

	function _postBatch(aBatch) {
		return _sendBatch(aBatch).then(function (oResponse) {
			// the approuter rejects a stale CSRF token with 403 (e.g. after its session was renewed) - fetch a fresh one and retry once
			if (oResponse.status === 403 && _sCsrfToken) {
				_sCsrfToken = null;
				return _sendBatch(aBatch);
			}
			return oResponse;
		}).then(function (oResponse) {
			if (!oResponse.ok) {
				throw new Error("Error Log service responded with status " + oResponse.status);
			}
		});
	}

	function _flush() {
		if (!_aQueue.length) { return; }
		var aBatch = _aQueue.splice(0, _aQueue.length);
		_persistQueue();
		_postBatch(aBatch).catch(function (oError) {
			Log.warning("Error Capture Plugin: failed to send captured messages, re-queueing", oError);
			_aQueue = aBatch.concat(_aQueue).slice(-_oConfig.maxStoredOffline);
			_persistQueue();
		});
	}

	// ---------------------------------------------------------------------
	// sap.m.MessageBox - covers technical error dialogs, confirmation/
	// validation popups raised by standard Fiori apps and custom apps alike.
	// Takes the module as a parameter because an app running in an iframe
	// has its own UI5 core and therefore its own MessageBox.
	// ---------------------------------------------------------------------

	function _messageBoxSeverity(oMessageBox, sMethod, mOptions) {
		switch (sMethod) {
			case "error": return "Error";
			case "warning": return "Warning";
			case "success": return "Success";
			case "information": return "Information";
			case "confirm": return "Warning";
			case "alert": return "Information";
			default: // .show(vMessage, mOptions)
				if (mOptions.icon === oMessageBox.Icon.ERROR) { return "Error"; }
				if (mOptions.icon === oMessageBox.Icon.WARNING) { return "Warning"; }
				if (mOptions.icon === oMessageBox.Icon.SUCCESS) { return "Success"; }
				return "Information";
		}
	}

	function _wrapMessageBox(oMessageBox) {
		["show", "alert", "confirm", "error", "information", "success", "warning"].forEach(function (sMethod) {
			var fnOriginal = oMessageBox[sMethod];
			if (typeof fnOriginal !== "function" || fnOriginal.__errorCapturePatched) { return; }

			var fnWrapped = function () {
				// error()/warning()/alert()/... are implemented by calling MessageBox.show(), which is patched
				// too - only the outermost call is captured, or every dialog would be recorded twice
				if (_iMessageBoxDepth === 0) {
					try {
						var vMessage = arguments[0];
						var mOptions = arguments[1] || {};
						var sSeverity = _messageBoxSeverity(oMessageBox, sMethod, mOptions);
						if (_isCapturedSeverity(sSeverity)) {
							_capture({
								severity: sSeverity,
								message: typeof vMessage === "string" ? vMessage : String(vMessage),
								description: mOptions.details ? _stringifyDetails(mOptions.details) : undefined,
								messageCode: mOptions.messageCode,
								source: "MessageBox"
							});
						}
					} catch (oError) {
						Log.warning("Error Capture Plugin: failed to intercept MessageBox." + sMethod, oError);
					}
				}
				_iMessageBoxDepth++;
				try {
					return fnOriginal.apply(oMessageBox, arguments);
				} finally {
					_iMessageBoxDepth--;
				}
			};
			fnWrapped.__errorCapturePatched = true;
			oMessageBox[sMethod] = fnWrapped;
		});
	}

	// ---------------------------------------------------------------------
	// sap.m.MessageToast - transient screen messages
	// ---------------------------------------------------------------------

	function _wrapMessageToast(oMessageToast) {
		var fnOriginal = oMessageToast.show;
		if (typeof fnOriginal !== "function" || fnOriginal.__errorCapturePatched) { return; }

		var fnWrapped = function (sMessage) {
			try {
				if (_oConfig.captureMessageToast && _isCapturedSeverity("Information")) {
					_capture({ severity: "Information", message: sMessage, source: "MessageToast" });
				}
			} catch (oError) {
				Log.warning("Error Capture Plugin: failed to intercept MessageToast.show", oError);
			}
			return fnOriginal.apply(oMessageToast, arguments);
		};
		fnWrapped.__errorCapturePatched = true;
		oMessageToast.show = fnWrapped;
	}

	// ---------------------------------------------------------------------
	// sap.ui.core Message Model - covers inline/validation messages and the
	// message popover shown by list reports / object pages (incl. OData
	// backend error responses surfaced through Fiori Elements), for both
	// standard and custom-built apps.
	// ---------------------------------------------------------------------

	function _listenToMessageModel(oWin) {
		var oMessageModel;
		try {
			// sap.ui.core.Messaging (UI5 >= 1.118) wraps the very same singleton MessageManager,
			// but getMessageManager() remains the most version-tolerant way to reach it.
			oMessageModel = oWin.sap.ui.getCore().getMessageManager().getMessageModel();
		} catch (e) {
			Log.warning("Error Capture Plugin: message model not available", e);
			return;
		}

		var aKnownMessageIds = [];
		var oBinding = oMessageModel.bindList("/");
		var fnOnChange = function () {
			var aCurrentIds = [];
			oBinding.getContexts().forEach(function (oContext) {
				var oMessage = oContext.getObject();
				var sId = (oMessage.getId && oMessage.getId()) || (oMessage.id + "|" + oMessage.message);
				aCurrentIds.push(sId);
				if (aKnownMessageIds.indexOf(sId) !== -1) { return; }

				var sSeverity = oMessage.getType ? oMessage.getType() : oMessage.type;
				if (sSeverity !== "None" && _isCapturedSeverity(sSeverity)) {
					_capture({
						severity: sSeverity,
						message: oMessage.getMessage ? oMessage.getMessage() : oMessage.message,
						description: oMessage.getDescription ? oMessage.getDescription() : oMessage.description,
						messageCode: oMessage.getCode ? oMessage.getCode() : oMessage.code,
						source: "MessageManager"
					});
				}
			});
			aKnownMessageIds = aCurrentIds;
		};
		oBinding.attachChange(fnOnChange);
		_aCleanup.push(function () { oBinding.detachChange(fnOnChange); });
	}

	// ---------------------------------------------------------------------
	// Uncaught JS errors
	// ---------------------------------------------------------------------

	function _onWindowError(oEvent) {
		_capture({
			severity: "Error",
			message: oEvent.message || "Uncaught JavaScript error",
			stack: oEvent.error && oEvent.error.stack,
			source: "JSError",
			additionalInfo: JSON.stringify({ filename: oEvent.filename, lineno: oEvent.lineno, colno: oEvent.colno })
		});
	}

	function _onUnhandledRejection(oEvent) {
		var vReason = oEvent.reason;
		_capture({
			severity: "Error",
			message: (vReason && (vReason.message || String(vReason))) || "Unhandled promise rejection",
			stack: vReason && vReason.stack,
			source: "UnhandledRejection"
		});
	}

	function _listenToErrors(oWin) {
		oWin.addEventListener("error", _onWindowError);
		oWin.addEventListener("unhandledrejection", _onUnhandledRejection);
		_aCleanup.push(function () {
			oWin.removeEventListener("error", _onWindowError);
			oWin.removeEventListener("unhandledrejection", _onUnhandledRejection);
		});
	}

	// ---------------------------------------------------------------------
	// Failed service calls (fetch + XMLHttpRequest) - catches backend errors
	// even when the app handles them quietly and never shows a message.
	// OData $batch responses are 200 even when an operation inside failed,
	// so their bodies are scanned for the individual failed operations.
	// ---------------------------------------------------------------------

	function _shouldTrackRequest(sAbsoluteUrl) {
		if (sAbsoluteUrl.indexOf(_sBackendAbsoluteUrl) === 0) { return false; } // never report our own logging calls
		return !_aHttpIgnorePatterns.some(function (oPattern) {
			return oPattern.test(sAbsoluteUrl);
		});
	}

	function _isBatchRequest(sAbsoluteUrl) {
		return /\/\$batch(\?|$)/.test(sAbsoluteUrl);
	}

	// Pulls the human-readable message and code out of an OData V2/V4 (JSON or XML) or generic JSON error body.
	function _extractServiceError(sBody) {
		if (!sBody) { return {}; }
		try {
			var oJson = JSON.parse(sBody);
			var oError = oJson && (oJson.error || oJson["odata.error"]);
			if (oError) {
				var vMessage = oError.message;
				return {
					message: vMessage && typeof vMessage === "object" ? vMessage.value : vMessage,
					code: oError.code
				};
			}
			if (oJson && typeof oJson.message === "string") {
				return { message: oJson.message, code: oJson.code };
			}
		} catch (e) {
			var oMessage = /<message[^>]*>([^<]*)<\/message>/i.exec(sBody);
			var oCode = /<code>([^<]*)<\/code>/i.exec(sBody);
			if (oMessage) {
				return { message: oMessage[1], code: oCode && oCode[1] };
			}
		}
		return {};
	}

	// Returns one entry per failed operation inside a $batch response body (multipart or JSON format).
	function _findBatchFailures(sBody) {
		var aFailures = [];
		if (!sBody) { return aFailures; }

		if (sBody.charAt(0) === "{") { // OData V4 JSON batch format
			try {
				(JSON.parse(sBody).responses || []).forEach(function (oPart) {
					if (oPart.status >= 400 && aFailures.length < MAX_BATCH_FAILURES) {
						aFailures.push({ status: oPart.status, body: _stringifyDetails(oPart.body) });
					}
				});
			} catch (e) { /* not JSON after all - nothing to report */ }
			return aFailures;
		}

		// multipart/mixed: every operation has its own "HTTP/1.1 <status> <text>" line followed by its body
		var oStatusLine = /HTTP\/1\.1 (\d{3})([^\r\n]*)/g;
		var aParts = [];
		var oMatch;
		while ((oMatch = oStatusLine.exec(sBody)) !== null) {
			aParts.push({ index: oMatch.index, status: Number(oMatch[1]), statusText: oMatch[2].trim() });
		}
		aParts.forEach(function (oPart, i) {
			if (oPart.status < 400 || aFailures.length >= MAX_BATCH_FAILURES) { return; }
			var sPart = sBody.slice(oPart.index, i + 1 < aParts.length ? aParts[i + 1].index : undefined);
			var iJsonStart = sPart.indexOf("{");
			var iJsonEnd = sPart.lastIndexOf("}");
			var iXmlStart = sPart.indexOf("<?xml");
			var sPartBody = iJsonStart !== -1 && iJsonEnd > iJsonStart ? sPart.slice(iJsonStart, iJsonEnd + 1)
				: (iXmlStart !== -1 ? sPart.slice(iXmlStart) : undefined);
			aFailures.push({ status: oPart.status, statusText: oPart.statusText, body: sPartBody });
		});
		return aFailures;
	}

	function _captureHttpFailure(mRequest) {
		if (!_isCapturedSeverity("Error")) { return; }
		var oServiceError = _extractServiceError(mRequest.body);
		var sStatus = mRequest.status
			? "HTTP " + mRequest.status + (mRequest.statusText ? " " + mRequest.statusText : "")
			: "Network error" + (mRequest.statusText ? ": " + mRequest.statusText : "");
		var sRequest = mRequest.method + " " + mRequest.url + (mRequest.batch ? " (operation inside $batch)" : "");
		var sBody = mRequest.body ? String(mRequest.body).slice(0, _oConfig.httpErrorMaxBodyLength) : "";

		_capture({
			severity: "Error",
			message: oServiceError.message || (sStatus + " - " + sRequest),
			description: sStatus + " - " + sRequest + (sBody ? "\n\n" + sBody : ""),
			messageCode: oServiceError.code ? String(oServiceError.code) : "HTTP_" + (mRequest.status || "NETWORK"),
			source: "HttpError",
			additionalInfo: JSON.stringify({
				method: mRequest.method,
				requestUrl: mRequest.url,
				status: mRequest.status,
				durationMs: mRequest.durationMs,
				batchOperation: !!mRequest.batch
			})
		});
	}

	// fnReadBody returns the response text (or a promise of it) - only called when there is something to report.
	function _inspectResponse(mRequest, iStatus, sStatusText, fnReadBody) {
		var bBatch = _isBatchRequest(mRequest.url);
		if (iStatus < 400 && !bBatch) { return; }

		var mFailure = Object.assign({ status: iStatus, statusText: sStatusText, durationMs: Date.now() - mRequest.start }, mRequest);
		Promise.resolve().then(fnReadBody).then(function (sBody) {
			if (iStatus >= 400) {
				_captureHttpFailure(Object.assign(mFailure, { status: iStatus, statusText: sStatusText, body: sBody }));
				return;
			}
			_findBatchFailures(sBody).forEach(function (oFailure) {
				_captureHttpFailure(Object.assign({}, mFailure, oFailure, { batch: true }));
			});
		}).catch(function () {
			if (iStatus >= 400) {
				_captureHttpFailure(Object.assign(mFailure, { status: iStatus, statusText: sStatusText }));
			}
		});
	}

	function _wrapFetch(oWin) {
		var fnOriginal = oWin.fetch;
		if (typeof fnOriginal !== "function" || fnOriginal.__errorCapturePatched) { return; }

		var fnWrapped = function (vInput, mInit) {
			var mRequest;
			try {
				var sUrl = _toAbsoluteUrl(typeof vInput === "string" ? vInput : (vInput && vInput.url) || String(vInput), oWin);
				var sMethod = (mInit && mInit.method) || (vInput && typeof vInput === "object" && vInput.method) || "GET";
				if (_shouldTrackRequest(sUrl)) {
					mRequest = { method: String(sMethod).toUpperCase(), url: sUrl, start: Date.now() };
				}
			} catch (e) { /* never let tracking break the app's request */ }

			var oPromise = fnOriginal.apply(oWin, arguments);
			if (!mRequest) { return oPromise; }

			return oPromise.then(function (oResponse) {
				try {
					if (oResponse.type !== "opaque") {
						_inspectResponse(mRequest, oResponse.status, oResponse.statusText, function () {
							return oResponse.clone().text();
						});
					}
				} catch (e) { /* ignore */ }
				return oResponse;
			}, function (oError) {
				try {
					if (!_bUnloading && !(oError && oError.name === "AbortError")) {
						_captureHttpFailure(Object.assign({ status: 0, statusText: oError && oError.message, durationMs: Date.now() - mRequest.start }, mRequest));
					}
				} catch (e) { /* ignore */ }
				throw oError;
			});
		};
		fnWrapped.__errorCapturePatched = true;
		oWin.fetch = fnWrapped;
		_aCleanup.push(function () {
			if (oWin.fetch === fnWrapped) { oWin.fetch = fnOriginal; }
		});
	}

	function _wrapXhr(oWin) {
		var oProto = oWin.XMLHttpRequest && oWin.XMLHttpRequest.prototype;
		if (!oProto || oProto.open.__errorCapturePatched) { return; }
		var fnOriginalOpen = oProto.open;
		var fnOriginalSend = oProto.send;

		var fnWrappedOpen = function (sMethod, sUrl) {
			try {
				var sAbsoluteUrl = _toAbsoluteUrl(sUrl, oWin);
				this.__errorCaptureRequest = _shouldTrackRequest(sAbsoluteUrl)
					? { method: String(sMethod || "GET").toUpperCase(), url: sAbsoluteUrl }
					: null;
			} catch (e) { /* ignore */ }
			return fnOriginalOpen.apply(this, arguments);
		};

		var fnWrappedSend = function () {
			var oXhr = this;
			var mRequest = oXhr.__errorCaptureRequest;
			if (mRequest) {
				try {
					var bAborted = false;
					mRequest.start = Date.now();
					oXhr.addEventListener("abort", function () { bAborted = true; });
					oXhr.addEventListener("loadend", function () {
						try {
							if (bAborted) { return; }
							if (oXhr.status === 0) {
								if (!_bUnloading) {
									_captureHttpFailure(Object.assign({ status: 0, statusText: "request failed or was blocked", durationMs: Date.now() - mRequest.start }, mRequest));
								}
								return;
							}
							_inspectResponse(mRequest, oXhr.status, oXhr.statusText, function () {
								return oXhr.responseType === "" || oXhr.responseType === "text" ? oXhr.responseText : undefined;
							});
						} catch (e) { /* ignore */ }
					});
				} catch (e) { /* ignore */ }
			}
			return fnOriginalSend.apply(this, arguments);
		};

		fnWrappedOpen.__errorCapturePatched = true;
		oProto.open = fnWrappedOpen;
		oProto.send = fnWrappedSend;
		_aCleanup.push(function () {
			if (oProto.open === fnWrappedOpen) {
				oProto.open = fnOriginalOpen;
				oProto.send = fnOriginalSend;
			}
		});
	}

	// ---------------------------------------------------------------------
	// Per-window instrumentation. The launchpad page is instrumented at init;
	// apps that Work Zone loads into a same-origin iframe get the same
	// treatment as soon as their frame loads. Cross-origin frames (e.g. an
	// ABAP system on another domain) can't be reached - the browser forbids it.
	// ---------------------------------------------------------------------

	function _instrumentWindow(oWin) {
		if (_oInstrumentedWindows.has(oWin)) { return false; }
		_oInstrumentedWindows.add(oWin);
		if (_oConfig.captureUnhandledJsErrors) {
			_listenToErrors(oWin);
		}
		if (_oConfig.captureHttpErrors) {
			_wrapFetch(oWin);
			_wrapXhr(oWin);
		}
		return true;
	}

	// UI5 in an iframe boots asynchronously - wait for it, then patch that frame's own MessageBox/MessageToast
	// and message model. Requiring the modules as soon as the loader exists means our callback is registered
	// before the app's own require for them, so the patch is in place before the app's first message.
	function _instrumentFrameUi5(oWin, iAttempt) {
		var bUi5Ready;
		try {
			bUi5Ready = !!(oWin.sap && oWin.sap.ui && oWin.sap.ui.require && oWin.sap.ui.getCore);
		} catch (e) {
			return; // the frame navigated to another origin or was removed
		}
		if (!bUi5Ready) {
			if (iAttempt < UI5_WAIT_MAX_ATTEMPTS && _bInitialized) {
				window.setTimeout(function () { _instrumentFrameUi5(oWin, iAttempt + 1); }, UI5_WAIT_INTERVAL_MS);
			}
			return;
		}
		oWin.sap.ui.require(["sap/m/MessageBox", "sap/m/MessageToast"], function (oFrameMessageBox, oFrameMessageToast) {
			_wrapMessageBox(oFrameMessageBox);
			_wrapMessageToast(oFrameMessageToast);
		});
		try {
			oWin.sap.ui.getCore().attachInit(function () { _listenToMessageModel(oWin); });
		} catch (e) {
			Log.warning("Error Capture Plugin: could not attach to an iframe app's message model", e);
		}
	}

	function _instrumentIframe(oIframe) {
		var oWin;
		try {
			oWin = oIframe.contentWindow;
			if (!oWin || oWin === window || oWin.location.href === "about:blank") { return; }
			void oWin.document.body; // throws for a cross-origin frame
		} catch (e) {
			return;
		}
		if (_instrumentWindow(oWin)) {
			_instrumentFrameUi5(oWin, 0);
		}
	}

	function _attachToIframe(oIframe) {
		if (oIframe.__errorCaptureAttached) { return; }
		oIframe.__errorCaptureAttached = true;
		var fnOnLoad = function () { _instrumentIframe(oIframe); };
		oIframe.addEventListener("load", fnOnLoad); // fires again whenever the frame navigates to a new app
		_aCleanup.push(function () { oIframe.removeEventListener("load", fnOnLoad); });
		_instrumentIframe(oIframe); // in case it had already loaded
	}

	function _watchIframes() {
		if (typeof MutationObserver === "undefined") { return; }
		var fnAttachWithin = function (oNode) {
			if (oNode.tagName === "IFRAME") {
				_attachToIframe(oNode);
			} else if (oNode.querySelectorAll) {
				Array.prototype.forEach.call(oNode.querySelectorAll("iframe"), _attachToIframe);
			}
		};
		var oObserver = new MutationObserver(function (aMutations) {
			aMutations.forEach(function (oMutation) {
				Array.prototype.forEach.call(oMutation.addedNodes, function (oNode) {
					if (oNode.nodeType === 1) { fnAttachWithin(oNode); }
				});
			});
		});
		oObserver.observe(document.documentElement, { childList: true, subtree: true });
		fnAttachWithin(document.documentElement);
		_aCleanup.push(function () { oObserver.disconnect(); });
	}

	function _onPageHide() {
		_bUnloading = true; // requests the browser cancels while leaving the page are not real service errors
		_flush();
	}

	// ---------------------------------------------------------------------
	// Public API
	// ---------------------------------------------------------------------

	return {

		init: function (mConfig) {
			if (_bInitialized) { return; }

			_oConfig = Object.assign({
				backendBaseUrl: "odata/v4/error-log",
				capturedSeverities: ["Error", "Warning"],
				captureMessageToast: true,
				captureUnhandledJsErrors: true,
				captureHttpErrors: true,
				httpErrorIgnoreUrlPatterns: [],
				httpErrorMaxBodyLength: 2000,
				captureSameOriginIframes: true,
				duplicateWindowMs: 2000,
				flushIntervalMs: 5000,
				maxQueueLength: 200,
				maxStoredOffline: 500,
				standardAppNamespacePrefixes: ["sap.", "com.sap."]
			}, mConfig || {});
			_oConfig.backendBaseUrl = _resolveBackendBaseUrl(_oConfig.backendBaseUrl);
			_sBackendAbsoluteUrl = _toAbsoluteUrl(_oConfig.backendBaseUrl, window);
			_aHttpIgnorePatterns = (_oConfig.httpErrorIgnoreUrlPatterns || []).reduce(function (aPatterns, sPattern) {
				try {
					aPatterns.push(new RegExp(sPattern, "i"));
				} catch (e) {
					Log.warning("Error Capture Plugin: ignoring invalid httpErrorIgnoreUrlPatterns entry " + sPattern);
				}
				return aPatterns;
			}, []);

			_restoreQueue();
			_refreshAppContext();

			_wrapMessageBox(MessageBox);
			_wrapMessageToast(MessageToast);
			_listenToMessageModel(window);
			_instrumentWindow(window);
			if (_oConfig.captureSameOriginIframes) {
				_watchIframes();
			}

			window.addEventListener("hashchange", _onHashChange);
			_iFlushIntervalId = window.setInterval(_flush, _oConfig.flushIntervalMs);
			window.addEventListener("pagehide", _onPageHide);
			window.addEventListener("beforeunload", _flush);

			_bInitialized = true;
			Log.info("Error Capture Plugin: initialized", JSON.stringify(_oConfig));
		},

		// exposed for unit tests / manual flush (e.g. from an admin action)
		flush: _flush,

		destroy: function () {
			if (!_bInitialized) { return; }
			window.clearInterval(_iFlushIntervalId);
			window.clearTimeout(_iHashChangeTimeoutId);
			window.removeEventListener("hashchange", _onHashChange);
			window.removeEventListener("pagehide", _onPageHide);
			window.removeEventListener("beforeunload", _flush);
			_aCleanup.forEach(function (fnCleanup) {
				try {
					fnCleanup();
				} catch (e) { /* the window it belonged to may already be gone */ }
			});
			_aCleanup = [];
			_oInstrumentedWindows = new WeakSet();
			_flush();
			_bInitialized = false;
		}
	};
});
