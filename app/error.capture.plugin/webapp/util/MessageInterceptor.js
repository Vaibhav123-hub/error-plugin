sap.ui.define([
	"sap/m/MessageBox",
	"sap/m/Button",
	"sap/ui/core/Element",
	"sap/base/Log",
	"error/capture/plugin/util/ServiceError"
], function (MessageBox, Button, Element, Log, ServiceError) {
	"use strict";

	var UI5_WAIT_INTERVAL_MS = 250;
	var UI5_WAIT_MAX_ATTEMPTS = 120; // give an iframe app ~30s to boot UI5 before giving up on it
	var MAX_BATCH_FAILURES = 10;     // cap errors per $batch response, so one bad batch can't flood the list
	var MAX_RECENT = 20;             // captured errors kept in memory for matching channels of one interaction

	var _bInitialized = false;
	var _bUnloading = false;
	var _oConfig = {};
	var _mHandlers = {};
	var _aRecent = [];               // most recent last
	var _aHttpIgnorePatterns = [];
	var _aMessageIgnorePatterns = [];
	var _oAppContext = {};
	var _sCurrentIntent;
	var _aCleanup = [];
	var _oInstrumentedWindows = new WeakSet();
	var _iMessageBoxCount = 0;

	function _isCapturedSeverity(sSeverity) {
		return _oConfig.capturedSeverities.indexOf(sSeverity) !== -1;
	}

	function _toAbsoluteUrl(sUrl, oWin) {
		try {
			return new URL(sUrl, oWin.location.href).href;
		} catch (e) {
			return String(sUrl);
		}
	}

	function _compileRegExps(aPatterns, sConfigName) {
		return (aPatterns || []).reduce(function (aRegExps, sPattern) {
			try {
				aRegExps.push(new RegExp(sPattern, "i"));
			} catch (e) {
				Log.warning("Error Capture Plugin: ignoring invalid " + sConfigName + " entry " + sPattern);
			}
			return aRegExps;
		}, []);
	}

	function _normalizeText(v) {
		return v == null ? "" : String(v).replace(/\s+/g, " ").trim();
	}

	// SAP message codes arrive as "<message class>/<number>" - OData V2 Gateway and RAP error codes (e.g. "M3/305"),
	// or what an app passes itself. The class may contain slashes of its own ("/IWBEP/CM_MGW_RT/020"), so the
	// number is whatever follows the last one. Anything else (HTTP_500, app-specific codes) has no message id/number.
	function _parseSapMessageCode(sCode) {
		var oMatch = /^(.+)\/(\d{3})$/.exec(_normalizeText(sCode));
		return oMatch ? { messageId: oMatch[1], messageNumber: oMatch[2] } : {};
	}

	// ---------------------------------------------------------------------
	// App context (which app on the FLP raised the message)
	// ---------------------------------------------------------------------

	function _parseIntent() {
		try {
			var oMatch = /#([^&/?]+)-([^&/?~]+)/.exec(window.location.hash || "");
			return oMatch ? oMatch[1] + "-" + oMatch[2] : undefined;
		} catch (e) {
			return undefined;
		}
	}

	// The intent in the URL hash ("SalesOrder-manage") is known the moment the user navigates, so every error from
	// then on - including ones raised while the new app is still loading - belongs to the new app straight away.
	// Once the launchpad reports the app as loaded, its sap.app/id refines it.
	function _setContextFromIntent() {
		_oAppContext = { appId: _parseIntent() };
	}

	function _applyLoadedApp(oApp) {
		var oComponent = oApp && !oApp.homePage && oApp.componentInstance;
		if (!oComponent || typeof oComponent.getManifestEntry !== "function") { return; } // home, or a non-UI5 app
		var oAppManifest = oComponent.getManifestEntry("sap.app") || {};
		if (oAppManifest.id) { _oAppContext.appId = oAppManifest.id; }
		if (oAppManifest.title && oAppManifest.title.indexOf("{{") !== 0) { _oAppContext.appTitle = oAppManifest.title; }
	}

	function _onAppLoaded(oEvent) {
		_applyLoadedApp(oEvent.getParameters());
	}

	function _watchLoadedApps() {
		if (!(window.sap && sap.ushell && sap.ushell.Container && sap.ushell.Container.getServiceAsync)) {
			return;
		}
		sap.ushell.Container.getServiceAsync("AppLifeCycle").then(function (oAppLifeCycle) {
			if (!_bInitialized) { return; }
			_applyLoadedApp(oAppLifeCycle.getCurrentApplication()); // the app already open when the plugin started
			oAppLifeCycle.attachAppLoaded(_onAppLoaded);
			_aCleanup.push(function () { oAppLifeCycle.detachAppLoaded(_onAppLoaded); });
		}).catch(function (oError) {
			Log.warning("Error Capture Plugin: could not resolve the current app", oError);
		});
	}

	function _onHashChange() {
		var sIntent = _parseIntent();
		if (sIntent === _sCurrentIntent) { return; } // in-app navigation (same intent, different inner route)
		// another app (or home) is now open: errors captured in the previous one are no longer relevant
		_sCurrentIntent = sIntent;
		_setContextFromIntent();
		_aRecent = [];
		if (_mHandlers.onClear) { _mHandlers.onClear(); }
	}

	// ---------------------------------------------------------------------
	// Capture
	// ---------------------------------------------------------------------

	// The same text again is the same error, and stays one entry - the user sees one row per distinct error:
	// - within duplicateWindowMs it is one interaction surfacing through several channels: a failed call (HttpError,
	//   carrying the SAP message code) and the dialog/message showing its text (usually without the code). Merging them
	//   means whichever channel the user asks AI from gets the message id/number too.
	// - later, it is the error happening again, counted in occurrences.
	function _findSameError(oEntry) {
		var sText = _normalizeText(oEntry.message);
		for (var i = _aRecent.length - 1; i >= 0; i--) {
			if (_normalizeText(_aRecent[i].message) === sText) { return _aRecent[i]; }
		}
		return null;
	}

	// Returns the entry describing the error - a merged earlier one if this is the same interaction - or null if
	// the message is ignored.
	function _capture(mEntry) {
		var sMessage = _normalizeText(mEntry.message);
		if (!sMessage || _aMessageIgnorePatterns.some(function (oPattern) { return oPattern.test(sMessage); })) {
			return null;
		}

		var oEntry = Object.assign({
			capturedAt: Date.now(),
			occurrences: 1,
			appId: _oAppContext.appId,
			appTitle: _oAppContext.appTitle
		}, mEntry, _parseSapMessageCode(mEntry.messageCode));

		var oSame = _findSameError(oEntry);
		if (oSame) {
			if (oEntry.capturedAt - oSame.capturedAt > _oConfig.duplicateWindowMs) {
				oSame.occurrences++;
			}
			// keep the first entry (a MessageBox's Ask AI button already holds it) and fill in what it lacked
			["messageCode", "messageId", "messageNumber"].forEach(function (sField) {
				if (!oSame[sField] && oEntry[sField]) { oSame[sField] = oEntry[sField]; }
			});
			oSame.capturedAt = oEntry.capturedAt;
			_aRecent.splice(_aRecent.indexOf(oSame), 1);
			oEntry = oSame;
		}
		_aRecent.push(oEntry);
		if (_aRecent.length > MAX_RECENT) { _aRecent.shift(); }

		if (_mHandlers.onCapture) {
			try {
				_mHandlers.onCapture(oEntry);
			} catch (oError) {
				Log.warning("Error Capture Plugin: onCapture handler failed", oError);
			}
		}
		return oEntry;
	}

	// ---------------------------------------------------------------------
	// sap.m.MessageBox - error/warning dialogs of standard Fiori apps and
	// custom apps alike. alert/confirm/error/information/success/warning are
	// all implemented by MessageBox.show, which builds the dialog and opens it
	// synchronously - so only show is patched, and right after it returns the
	// dialog is looked up by id and gets an "Ask AI" button. Takes the modules
	// as parameters because an app in an iframe has its own UI5 core.
	// ---------------------------------------------------------------------

	function _messageBoxSeverity(oMessageBox, mOptions) {
		switch (mOptions.icon) {
			case oMessageBox.Icon.ERROR: return "Error";
			case oMessageBox.Icon.WARNING: return "Warning";
			case oMessageBox.Icon.SUCCESS: return "Success";
			default: return "Information"; // INFORMATION, QUESTION (confirm), NONE
		}
	}

	function _messageBoxText(vMessage) {
		if (typeof vMessage === "string") { return vMessage; }
		// show() also accepts a control (e.g. a FormattedText) as the message
		if (vMessage && typeof vMessage.getText === "function") { return vMessage.getText(); }
		if (vMessage && typeof vMessage.getHtmlText === "function") { return vMessage.getHtmlText().replace(/<[^>]*>/g, " "); }
		return String(vMessage);
	}

	// Element.getElementById exists from UI5 1.119; an app in an iframe may run an older UI5 of its own
	function _getElementById(ElementClass, sId) {
		if (typeof ElementClass.getElementById === "function") { return ElementClass.getElementById(sId); }
		return ElementClass.registry && ElementClass.registry.get(sId);
	}

	function _addAskAiButton(oDialog, oEntry, ButtonClass) {
		if (!oDialog || typeof oDialog.insertButton !== "function") { return; }
		// without an initial focus the dialog focuses its first button, which would now be Ask AI - keep the focus
		// (and so Enter/Escape habits) on the app's own first action
		var aButtons = oDialog.getButtons();
		if (!oDialog.getInitialFocus() && aButtons.length) {
			oDialog.setInitialFocus(aButtons[0]);
		}
		oDialog.insertButton(new ButtonClass({
			text: _oConfig.texts.askAiButton,
			tooltip: _oConfig.texts.askAiButtonTooltip,
			icon: _oConfig.askAiIcon,
			// a real click on the dialog, so the browser lets the new tab open; the dialog stays open and the app's
			// own onClose is not involved
			press: function () { _mHandlers.onAskAi(oEntry); }
		}), 0);
	}

	function _wrapMessageBox(oMessageBox, ButtonClass, ElementClass) {
		var fnOriginal = oMessageBox.show;
		if (typeof fnOriginal !== "function" || fnOriginal.__errorCapturePatched) { return; }

		var fnWrapped = function (vMessage, mOptions) {
			var oEntry = null;
			var mArgs = arguments;
			try {
				var sSeverity = _messageBoxSeverity(oMessageBox, mOptions || {});
				if (_isCapturedSeverity(sSeverity)) {
					oEntry = _capture({
						severity: sSeverity,
						message: _messageBoxText(vMessage),
						messageCode: mOptions && mOptions.messageCode, // not a MessageBox option, but some apps pass it
						source: "MessageBox"
					});
				}
				if (oEntry) {
					// the user saw this one in a dialog (merged entries included) - no extra notification needed
					oEntry.shownInDialog = true;
				}
				if (oEntry && _oConfig.addAskAiButtonToMessageBox && !(mOptions && mOptions.id)) {
					// show() generates the dialog id itself when none is given - give it one we can look up
					mArgs = [vMessage, Object.assign({}, mOptions, { id: "errorCaptureMessageBox" + (++_iMessageBoxCount) })];
				}
			} catch (oError) {
				Log.warning("Error Capture Plugin: failed to intercept MessageBox.show", oError);
			}

			var vResult = fnOriginal.apply(oMessageBox, mArgs);

			if (oEntry && _oConfig.addAskAiButtonToMessageBox) {
				try {
					_addAskAiButton(_getElementById(ElementClass, mArgs[1].id), oEntry, ButtonClass);
				} catch (oError) {
					Log.warning("Error Capture Plugin: could not add the Ask AI button to a MessageBox", oError);
				}
			}
			return vResult;
		};
		fnWrapped.__errorCapturePatched = true;
		oMessageBox.show = fnWrapped;
		_aCleanup.push(function () {
			if (oMessageBox.show === fnWrapped) { oMessageBox.show = fnOriginal; }
		});
	}

	// ---------------------------------------------------------------------
	// sap.ui.core Message Model - inline/validation messages and the message
	// popover/dialog of Fiori Elements list reports & object pages (incl.
	// OData backend errors, which carry the SAP message code).
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
		if (!_isCapturedSeverity("Error")) { return; }
		_capture({ severity: "Error", message: oEvent.message || "Uncaught JavaScript error", source: "JSError" });
	}

	function _onUnhandledRejection(oEvent) {
		if (!_isCapturedSeverity("Error")) { return; }
		var vReason = oEvent.reason;
		_capture({
			severity: "Error",
			message: (vReason && (vReason.message || String(vReason))) || "Unhandled promise rejection",
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
	// even when the app handles them quietly and never shows a message, and
	// supplies the SAP message code for the dialog that does show one.
	// OData $batch responses are 200 even when an operation inside failed,
	// so their bodies are scanned for the individual failed operations.
	// ---------------------------------------------------------------------

	function _shouldTrackRequest(sAbsoluteUrl) {
		return !_aHttpIgnorePatterns.some(function (oPattern) {
			return oPattern.test(sAbsoluteUrl);
		});
	}

	function _isBatchRequest(sAbsoluteUrl) {
		return /\/\$batch(\?|$)/.test(sAbsoluteUrl);
	}

	// Returns one entry per failed operation inside a $batch response body (multipart or JSON format).
	function _findBatchFailures(sBody) {
		var aFailures = [];
		if (!sBody) { return aFailures; }

		if (sBody.charAt(0) === "{") { // OData V4 JSON batch format
			try {
				(JSON.parse(sBody).responses || []).forEach(function (oPart) {
					if (oPart.status >= 400 && aFailures.length < MAX_BATCH_FAILURES) {
						aFailures.push({ status: oPart.status, body: JSON.stringify(oPart.body) });
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
		// the backend's own message is what the app shows too (so a dialog showing it merges with this entry); without
		// one, a plain-language description of the status - never the raw URL, whose keys can carry business data
		var oServiceError = ServiceError.extract(mRequest.body);

		_capture({
			severity: "Error",
			message: oServiceError.message || ServiceError.describe(mRequest, _oConfig.texts),
			messageCode: oServiceError.code ? String(oServiceError.code) : "HTTP_" + (mRequest.status || "NETWORK"),
			source: "HttpError"
		});
	}

	// fnReadBody returns the response text (or a promise of it) - only called when there is something to report.
	function _inspectResponse(mRequest, iStatus, sStatusText, fnReadBody) {
		var bBatch = _isBatchRequest(mRequest.url);
		if (iStatus < 400 && !bBatch) { return; }

		var mFailure = Object.assign({ status: iStatus, statusText: sStatusText }, mRequest);
		Promise.resolve().then(fnReadBody).then(function (sBody) {
			if (iStatus >= 400) {
				_captureHttpFailure(Object.assign(mFailure, { body: sBody }));
				return;
			}
			_findBatchFailures(sBody).forEach(function (oFailure) {
				_captureHttpFailure(Object.assign({}, mFailure, oFailure, { batch: true }));
			});
		}).catch(function () {
			if (iStatus >= 400) {
				_captureHttpFailure(mFailure);
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
					mRequest = { method: String(sMethod).toUpperCase(), url: sUrl };
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
						_captureHttpFailure(Object.assign({ status: 0, statusText: oError && oError.message }, mRequest));
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
					oXhr.addEventListener("abort", function () { bAborted = true; });
					oXhr.addEventListener("loadend", function () {
						try {
							if (bAborted) { return; }
							if (oXhr.status === 0) {
								if (!_bUnloading) {
									_captureHttpFailure(Object.assign({ status: 0, statusText: "request failed or was blocked" }, mRequest));
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

	// UI5 in an iframe boots asynchronously - wait for it, then patch that frame's own MessageBox and message
	// model. Requiring the modules as soon as the loader exists means our callback is registered before the
	// app's own require for them, so the patch is in place before the app's first message.
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
		oWin.sap.ui.require(["sap/m/MessageBox", "sap/m/Button", "sap/ui/core/Element"], function (oFrameMessageBox, FrameButton, FrameElement) {
			_wrapMessageBox(oFrameMessageBox, FrameButton, FrameElement);
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
	}

	// ---------------------------------------------------------------------
	// Public API
	// ---------------------------------------------------------------------

	return {

		/**
		 * @param {object} mConfig sap.ui5/config/errorCapture from the plugin's manifest.json, plus <code>texts</code>
		 * @param {object} mHandlers
		 * @param {function(object)} mHandlers.onAskAi called with a captured entry when its Ask AI button is pressed
		 * @param {function(object)} [mHandlers.onCapture] called with the entry whenever an error is captured
		 * @param {function()} [mHandlers.onClear] called when another app is opened and earlier errors are dropped
		 */
		init: function (mConfig, mHandlers) {
			if (_bInitialized) { return; }

			_oConfig = Object.assign({
				capturedSeverities: ["Error", "Warning"],
				addAskAiButtonToMessageBox: true,
				askAiIcon: "sap-icon://ai",
				captureUnhandledJsErrors: true,
				captureHttpErrors: true,
				httpErrorIgnoreUrlPatterns: [],
				ignoreMessagePatterns: [],
				captureSameOriginIframes: true,
				duplicateWindowMs: 2000,
				texts: {}
			}, mConfig || {});
			_mHandlers = mHandlers || {};
			_aHttpIgnorePatterns = _compileRegExps(_oConfig.httpErrorIgnoreUrlPatterns, "httpErrorIgnoreUrlPatterns");
			_aMessageIgnorePatterns = _compileRegExps(_oConfig.ignoreMessagePatterns, "ignoreMessagePatterns");

			_sCurrentIntent = _parseIntent();
			_setContextFromIntent();

			_wrapMessageBox(MessageBox, Button, Element);
			_listenToMessageModel(window);
			_instrumentWindow(window);
			if (_oConfig.captureSameOriginIframes) {
				_watchIframes();
			}

			window.addEventListener("hashchange", _onHashChange);
			window.addEventListener("pagehide", _onPageHide);

			_bInitialized = true;
			_watchLoadedApps();
			Log.info("Error Capture Plugin: initialized", JSON.stringify(_oConfig));
		},

		/** @returns {object|undefined} the most recently captured error in the current app */
		getLatest: function () {
			return _aRecent[_aRecent.length - 1];
		},

		/** @returns {object[]} the errors captured in the current app, newest first */
		getAll: function () {
			return _aRecent.slice().reverse();
		},

		/** Forgets the errors captured in the current app, e.g. when the user clears the list. */
		clear: function () {
			_aRecent = [];
			if (_mHandlers.onClear) { _mHandlers.onClear(); }
		},

		destroy: function () {
			if (!_bInitialized) { return; }
			window.removeEventListener("hashchange", _onHashChange);
			window.removeEventListener("pagehide", _onPageHide);
			_aCleanup.forEach(function (fnCleanup) {
				try {
					fnCleanup();
				} catch (e) { /* the window it belonged to may already be gone */ }
			});
			_aCleanup = [];
			_aRecent = [];
			_oInstrumentedWindows = new WeakSet();
			_bInitialized = false;
		}
	};
});
