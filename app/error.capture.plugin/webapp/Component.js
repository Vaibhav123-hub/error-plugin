sap.ui.define([
	"sap/ui/core/UIComponent",
	"sap/m/MessageToast",
	"error/capture/plugin/util/MessageInterceptor",
	"error/capture/plugin/util/AskAI",
	"error/capture/plugin/util/AskAIHeaderItem",
	"error/capture/plugin/util/ErrorListDialog"
], function (UIComponent, MessageToast, MessageInterceptor, AskAI, AskAIHeaderItem, ErrorListDialog) {
	"use strict";

	return UIComponent.extend("error.capture.plugin.Component", {

		metadata: {
			manifest: "json"
		},

		// FLP plugins are headless: they run once when the shell loads them and never render a view.
		init: function () {
			UIComponent.prototype.init.apply(this, arguments);

			var mConfig = this.getManifestEntry("/sap.ui5/config/errorCapture") || {};
			var oBundle = this.getModel("i18n").getResourceBundle();
			var mTexts = {};
			["askAiButton", "askAiButtonTooltip", "askAiHeaderText", "askAiHeaderTooltipOne", "askAiHeaderTooltipMany",
				"errorListTitle", "errorListIntro", "errorListEmpty", "errorListClear", "errorListClose", "errorSourceDialog",
				"errorSourceMessages", "errorSourceHttp", "errorSourceScript", "errorOccurrences", "errorNotification"].forEach(function (sKey) {
				mTexts[sKey] = oBundle.getText(sKey);
			});
			this._mConfig = mConfig;
			this._mTexts = mTexts;
			this._bNotified = false;

			var fnAskAi = AskAI.open.bind(AskAI);
			AskAI.init(mConfig);
			if (mConfig.showAskAiHeaderButton !== false) {
				ErrorListDialog.init(mTexts, mConfig.askAiIcon, {
					onAskAi: fnAskAi,
					onClearAll: MessageInterceptor.clear
				});
				AskAIHeaderItem.init(mTexts, mConfig.askAiIcon, function () {
					this._bNotified = false; // the user has looked - notify again about the next error
					ErrorListDialog.open(MessageInterceptor.getAll());
				}.bind(this));
			}
			MessageInterceptor.init(Object.assign({}, mConfig, { texts: mTexts }), {
				onAskAi: fnAskAi,
				onCapture: function (oEntry) {
					this._refreshErrorList();
					this._notifyAboutError(oEntry);
				}.bind(this),
				onClear: function () {
					this._bNotified = false;
					ErrorListDialog.close();
					this._refreshErrorList();
				}.bind(this)
			});
		},

		_refreshErrorList: function () {
			var aEntries = MessageInterceptor.getAll();
			AskAIHeaderItem.update(aEntries.length);
			ErrorListDialog.update(aEntries);
		},

		// Errors the user saw in a MessageBox already have an Ask AI button there. For the others (Fiori Elements
		// message dialogs, failed calls, script errors) a toast points to the header button - once, until the user has
		// opened the list or another app.
		_notifyAboutError: function (oEntry) {
			if (this._mConfig.showAskAiHeaderButton === false || this._mConfig.notifyErrorsWithoutDialog === false || this._bNotified) {
				return;
			}
			window.clearTimeout(this._iNotifyTimeoutId);
			// a dialog showing the same error may follow the failed call that caused it - wait for it first
			this._iNotifyTimeoutId = window.setTimeout(function () {
				if (this._bNotified || oEntry.shownInDialog || MessageInterceptor.getAll().indexOf(oEntry) === -1) { return; }
				this._bNotified = true;
				MessageToast.show(this._mTexts.errorNotification, { duration: 6000, width: "24rem" });
			}.bind(this), this._mConfig.duplicateWindowMs || 2000);
		},

		exit: function () {
			window.clearTimeout(this._iNotifyTimeoutId);
			MessageInterceptor.destroy();
			AskAIHeaderItem.destroy();
			ErrorListDialog.destroy();
			UIComponent.prototype.exit.apply(this, arguments);
		}
	});
});
