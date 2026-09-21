sap.ui.define([
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"sap/base/Log"
], function (MessageBox, MessageToast, Log) {
	"use strict";

	var STORAGE_KEY = "errorCapturePlugin.queue";

	var _bInitialized = false;
	var _oConfig = {};
	var _aQueue = [];
	var _sCsrfToken = null;
	var _oAppContext = {};
	var _oMessageListBinding = null;
	var _aKnownMessageIds = [];
	var _iFlushIntervalId = null;
	var _iHashChangeTimeoutId = null;

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

	function _capture(mEntry) {
		var oEntry = Object.assign({
			timestamp: new Date().toISOString(),
			appId: _oAppContext.appId,
			appTitle: _oAppContext.appTitle,
			tileId: _oAppContext.tileId,
			standardApp: !!_oAppContext.standardApp,
			url: window.location.href,
			userAgent: navigator.userAgent
		}, mEntry);

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
	// validation popups raised by standard Fiori apps and custom apps alike
	// ---------------------------------------------------------------------

	function _messageBoxSeverity(sMethod, mOptions) {
		switch (sMethod) {
			case "error": return "Error";
			case "warning": return "Warning";
			case "success": return "Success";
			case "information": return "Information";
			case "confirm": return "Warning";
			case "alert": return "Information";
			default: // .show(vMessage, mOptions)
				if (mOptions.icon === MessageBox.Icon.ERROR) { return "Error"; }
				if (mOptions.icon === MessageBox.Icon.WARNING) { return "Warning"; }
				if (mOptions.icon === MessageBox.Icon.SUCCESS) { return "Success"; }
				return "Information";
		}
	}

	function _wrapMessageBox() {
		["show", "alert", "confirm", "error", "information", "success", "warning"].forEach(function (sMethod) {
			var fnOriginal = MessageBox[sMethod];
			if (typeof fnOriginal !== "function" || fnOriginal.__errorCapturePatched) { return; }

			var fnWrapped = function () {
				try {
					var vMessage = arguments[0];
					var mOptions = arguments[1] || {};
					var sSeverity = _messageBoxSeverity(sMethod, mOptions);
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
				return fnOriginal.apply(MessageBox, arguments);
			};
			fnWrapped.__errorCapturePatched = true;
			MessageBox[sMethod] = fnWrapped;
		});
	}

	// ---------------------------------------------------------------------
	// sap.m.MessageToast - transient screen messages
	// ---------------------------------------------------------------------

	function _wrapMessageToast() {
		var fnOriginal = MessageToast.show;
		if (typeof fnOriginal !== "function" || fnOriginal.__errorCapturePatched) { return; }

		var fnWrapped = function (sMessage) {
			try {
				if (_oConfig.captureMessageToast) {
					_capture({ severity: "Information", message: sMessage, source: "MessageToast" });
				}
			} catch (oError) {
				Log.warning("Error Capture Plugin: failed to intercept MessageToast.show", oError);
			}
			return fnOriginal.apply(MessageToast, arguments);
		};
		fnWrapped.__errorCapturePatched = true;
		MessageToast.show = fnWrapped;
	}

	// ---------------------------------------------------------------------
	// sap.ui.core Message Model - covers inline/validation messages and the
	// message popover shown by list reports / object pages (incl. OData
	// backend error responses surfaced through Fiori Elements), for both
	// standard and custom-built apps.
	// ---------------------------------------------------------------------

	function _getMessageModel() {
		try {
			// sap.ui.core.Messaging (UI5 >= 1.118) wraps the very same singleton MessageManager,
			// but sap.ui.getCore().getMessageManager() remains the most version-tolerant way to reach it.
			return sap.ui.getCore().getMessageManager().getMessageModel();
		} catch (e) {
			Log.warning("Error Capture Plugin: message model not available", e);
			return null;
		}
	}

	function _onMessageModelChange() {
		var aContexts = _oMessageListBinding.getContexts();
		var aCurrentIds = [];
		aContexts.forEach(function (oContext) {
			var oMessage = oContext.getObject();
			var sId = (oMessage.getId && oMessage.getId()) || (oMessage.id + "|" + oMessage.message);
			aCurrentIds.push(sId);
			if (_aKnownMessageIds.indexOf(sId) !== -1) { return; }

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
		_aKnownMessageIds = aCurrentIds;
	}

	function _initMessageModelListener() {
		var oMessageModel = _getMessageModel();
		if (!oMessageModel) { return; }
		_oMessageListBinding = oMessageModel.bindList("/");
		_oMessageListBinding.attachChange(_onMessageModelChange);
	}

	// ---------------------------------------------------------------------
	// Uncaught JS errors anywhere on the FLP (shell + app iframe/component)
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

	function _wrapGlobalErrorHandlers() {
		window.addEventListener("error", _onWindowError);
		window.addEventListener("unhandledrejection", _onUnhandledRejection);
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
				flushIntervalMs: 5000,
				maxQueueLength: 200,
				maxStoredOffline: 500,
				standardAppNamespacePrefixes: ["sap.", "com.sap."]
			}, mConfig || {});
			_oConfig.backendBaseUrl = _resolveBackendBaseUrl(_oConfig.backendBaseUrl);

			_restoreQueue();
			_refreshAppContext();

			_wrapMessageBox();
			_wrapMessageToast();
			_initMessageModelListener();

			if (_oConfig.captureUnhandledJsErrors) {
				_wrapGlobalErrorHandlers();
			}

			window.addEventListener("hashchange", _onHashChange);
			_iFlushIntervalId = window.setInterval(_flush, _oConfig.flushIntervalMs);
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
			window.removeEventListener("beforeunload", _flush);
			window.removeEventListener("error", _onWindowError);
			window.removeEventListener("unhandledrejection", _onUnhandledRejection);
			if (_oMessageListBinding) {
				_oMessageListBinding.detachChange(_onMessageModelChange);
				_oMessageListBinding = null;
			}
			_flush();
			_bInitialized = false;
		}
	};
});
