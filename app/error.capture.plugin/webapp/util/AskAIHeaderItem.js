sap.ui.define([
	"sap/base/Log"
], function (Log) {
	"use strict";

	// "Ask AI" button in the launchpad header, with a badge counting the errors captured in the open app. Hidden while
	// there are none.
	// The shell's Extension service accepts only primitive properties and gives no access to the created control (no
	// stable ids, no setters), so a new count means destroying the item and creating it again with the new badge.
	var _mBaseProperties = null;
	var _mTexts = {};
	var _oItem = null;
	var _iRequestedCount = 0;
	var _pQueue = Promise.resolve(); // create/destroy calls are async - run them one after another

	function _destroyItem() {
		var oItem = _oItem;
		_oItem = null;
		return oItem ? oItem.destroy() : Promise.resolve();
	}

	function _render(iCount) {
		// several updates queued while one was running - only the newest still matters
		if (iCount !== _iRequestedCount) { return Promise.resolve(); }
		return _destroyItem().then(function () {
			if (!iCount) { return undefined; }
			var sTooltip = iCount === 1 ? _mTexts.askAiHeaderTooltipOne : _mTexts.askAiHeaderTooltipMany.replace("{0}", iCount);
			return sap.ushell.Container.getServiceAsync("Extension").then(function (oExtension) {
				return oExtension.createHeaderItem(Object.assign({}, _mBaseProperties, {
					floatingNumber: iCount,
					tooltip: sTooltip,
					ariaLabel: sTooltip
				}), { position: "end" });
			}).then(function (oItem) {
				_oItem = oItem;
				// showing it for all apps / home also stops the shell from destroying it on the next navigation
				oItem.showForAllApps().showOnHome();
			});
		});
	}

	return {

		/**
		 * @param {object} mTexts i18n texts (askAiHeaderText, askAiHeaderTooltipOne, askAiHeaderTooltipMany)
		 * @param {string} sIcon icon of the button
		 * @param {function()} fnPress called when the user presses the button
		 */
		init: function (mTexts, sIcon, fnPress) {
			if (!(window.sap && sap.ushell && sap.ushell.Container && sap.ushell.Container.getServiceAsync)) {
				Log.warning("Error Capture Plugin: not running in a launchpad - no Ask AI header button");
				return;
			}
			_mTexts = mTexts;
			_mBaseProperties = {
				icon: sIcon,
				text: mTexts.askAiHeaderText,
				ariaHaspopup: "dialog",
				press: fnPress
			};
		},

		/**
		 * Shows the button with this many errors on its badge, or hides it for 0.
		 * @param {int} iCount number of errors captured in the open app
		 */
		update: function (iCount) {
			if (!_mBaseProperties || iCount === _iRequestedCount) { return; }
			_iRequestedCount = iCount;
			_pQueue = _pQueue.then(function () {
				return _render(iCount);
			}).catch(function (oError) {
				Log.error("Error Capture Plugin: could not update the Ask AI button in the launchpad header", oError);
			});
		},

		destroy: function () {
			_iRequestedCount = 0;
			_mBaseProperties = null;
			_pQueue = _pQueue.then(_destroyItem).catch(function () { /* already logged */ });
		}
	};
});
