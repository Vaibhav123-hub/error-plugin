sap.ui.define([
	"sap/base/Log"
], function (Log) {
	"use strict";

	var _oConfig = {};
	var _oUser = {};

	function _resolveUser() {
		if (!(window.sap && sap.ushell && sap.ushell.Container && sap.ushell.Container.getServiceAsync)) {
			return;
		}
		sap.ushell.Container.getServiceAsync("UserInfo").then(function (oUserInfo) {
			_oUser = { name: oUserInfo.getId(), fullName: oUserInfo.getFullName() };
		}).catch(function (oError) {
			Log.warning("Error Capture Plugin: could not resolve the logged-in user", oError);
		});
	}

	function _truncate(sText, iMaxLength) {
		sText = sText == null ? "" : String(sText).replace(/\s+/g, " ").trim();
		return sText.length > iMaxLength ? sText.slice(0, iMaxLength - 1) + "…" : sText;
	}

	return {

		/**
		 * @param {object} mConfig sap.ui5/config/errorCapture from the plugin's manifest.json
		 */
		init: function (mConfig) {
			_oConfig = Object.assign({
				askAiUrl: "",
				askAiIncludeUser: true,
				askAiMaxMessageLength: 1000
			}, mConfig || {});
			if (!_oConfig.askAiUrl) {
				Log.error("Error Capture Plugin: askAiUrl is not configured - Ask AI cannot open");
			}
			if (_oConfig.askAiIncludeUser) {
				_resolveUser();
			}
		},

		/**
		 * The essential details of a captured error, as query parameters of the Ask AI service - the same ones the
		 * Performance Assistant (zmsghelp) sends.
		 * @param {object} oEntry an entry captured by MessageInterceptor
		 * @returns {string} the Ask AI URL for it
		 */
		buildUrl: function (oEntry) {
			var mParams = {
				message_id: oEntry.messageId || "",
				message_number: oEntry.messageNumber || "",
				// UI5 apps have no t-code - the app id (component id or semantic object-action) identifies the app instead
				transaction_code: oEntry.appId || "",
				message_text: _truncate(oEntry.message, _oConfig.askAiMaxMessageLength),
				user_name: _oConfig.askAiIncludeUser ? _oUser.name || "" : "",
				user_full_name: _oConfig.askAiIncludeUser ? _oUser.fullName || "" : ""
			};
			var sQuery = Object.keys(mParams).map(function (sName) {
				return sName + "=" + encodeURIComponent(mParams[sName]);
			}).join("&");
			return _oConfig.askAiUrl + (_oConfig.askAiUrl.indexOf("?") === -1 ? "?" : "&") + sQuery;
		},

		/**
		 * Opens the Ask AI service for a captured error in a new tab. Must be called from a user's click - browsers
		 * block new tabs opened any other way.
		 * @param {object} oEntry an entry captured by MessageInterceptor
		 */
		open: function (oEntry) {
			if (!oEntry || !_oConfig.askAiUrl) { return; }
			// noopener: the AI page is an external site and must not get a handle on the launchpad window
			window.open(this.buildUrl(oEntry), "_blank", "noopener");
		}
	};
});
