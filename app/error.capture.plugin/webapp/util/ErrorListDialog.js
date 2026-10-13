sap.ui.define([
	"sap/m/Dialog",
	"sap/m/Button",
	"sap/m/List",
	"sap/m/CustomListItem",
	"sap/m/HBox",
	"sap/m/VBox",
	"sap/m/FlexItemData",
	"sap/m/Text",
	"sap/m/Label",
	"sap/m/MessageStrip",
	"sap/ui/core/Icon",
	"sap/ui/model/json/JSONModel",
	"sap/ui/core/format/DateFormat",
	"sap/ui/Device"
], function (Dialog, Button, List, CustomListItem, HBox, VBox, FlexItemData, Text, Label, MessageStrip, Icon, JSONModel,
	DateFormat, Device) {
	"use strict";

	// "Errors in This App" dialog, opened from the launchpad header's Ask AI button: every error captured in the open
	// app, newest first, each with its own Ask AI button.
	var _mTexts = {};
	var _sAskAiIcon;
	var _mHandlers = {};
	var _oDialog = null;
	var _oModel = null;
	var _aEntries = [];
	var _oTimeFormat = DateFormat.getTimeInstance({ style: "medium" });

	var SEVERITY_ICONS = {
		Error: { src: "sap-icon://message-error", color: "Negative" },
		Warning: { src: "sap-icon://message-warning", color: "Critical" }
	};

	function _sourceText(sSource) {
		switch (sSource) {
			case "MessageBox": return _mTexts.errorSourceDialog;
			case "MessageManager": return _mTexts.errorSourceMessages;
			case "HttpError": return _mTexts.errorSourceHttp;
			default: return _mTexts.errorSourceScript; // JSError, UnhandledRejection
		}
	}

	function _toItems(aEntries) {
		return aEntries.map(function (oEntry, i) {
			var oIcon = SEVERITY_ICONS[oEntry.severity] || SEVERITY_ICONS.Error;
			return {
				index: i,
				message: oEntry.message,
				meta: [_sourceText(oEntry.source), _oTimeFormat.format(new Date(oEntry.capturedAt))]
					.concat(oEntry.occurrences > 1 ? [_mTexts.errorOccurrences.replace("{0}", oEntry.occurrences)] : [])
					.join(" · "),
				icon: oIcon.src,
				iconColor: oIcon.color
			};
		});
	}

	function _refresh() {
		if (!_oModel) { return; }
		_oModel.setData({
			title: _mTexts.errorListTitle.replace("{0}", _aEntries.length),
			items: _toItems(_aEntries)
		});
	}

	function _create() {
		_oModel = new JSONModel();
		var oList = new List({
			noDataText: _mTexts.errorListEmpty,
			items: {
				path: "/items",
				template: new CustomListItem({
					content: new HBox({
						alignItems: "Start",
						items: [
							new Icon({ src: "{icon}", color: "{iconColor}" }).addStyleClass("sapUiTinyMarginTop sapUiSmallMarginEnd"),
							new VBox({
								layoutData: new FlexItemData({ growFactor: 1, minWidth: "0" }),
								items: [
									new Text({ text: "{message}", maxLines: 3 }),
									new Label({ text: "{meta}", wrapping: true }).addStyleClass("sapUiTinyMarginTop")
								]
							}),
							new Button({
								text: _mTexts.askAiButton,
								tooltip: _mTexts.askAiButtonTooltip,
								icon: _sAskAiIcon,
								// a real click, so the browser lets the new tab open
								press: function (oEvent) {
									var oEntry = _aEntries[oEvent.getSource().getBindingContext().getProperty("index")];
									if (oEntry) { _mHandlers.onAskAi(oEntry); }
								}
							}).addStyleClass("sapUiSmallMarginBegin")
						]
					}).addStyleClass("sapUiSmallMargin")
				})
			}
		});

		_oDialog = new Dialog({
			title: "{/title}",
			contentWidth: "34rem",
			stretch: Device.system.phone,
			resizable: !Device.system.phone,
			draggable: !Device.system.phone,
			content: [
				new MessageStrip({ text: _mTexts.errorListIntro, type: "Information", showIcon: true }).addStyleClass("sapUiSmallMargin"),
				oList
			],
			buttons: [
				new Button({
					text: _mTexts.errorListClear,
					press: function () {
						_oDialog.close();
						_mHandlers.onClearAll();
					}
				}),
				new Button({
					text: _mTexts.errorListClose,
					type: "Emphasized",
					press: function () { _oDialog.close(); }
				})
			]
		});
		_oDialog.setModel(_oModel);
	}

	return {

		/**
		 * @param {object} mTexts i18n texts
		 * @param {string} sAskAiIcon icon of the Ask AI buttons
		 * @param {object} mHandlers
		 * @param {function(object)} mHandlers.onAskAi called with the entry whose Ask AI button was pressed
		 * @param {function()} mHandlers.onClearAll called when the user clears the list
		 */
		init: function (mTexts, sAskAiIcon, mHandlers) {
			_mTexts = mTexts;
			_sAskAiIcon = sAskAiIcon;
			_mHandlers = mHandlers;
		},

		/** @param {object[]} aEntries captured errors, newest first */
		open: function (aEntries) {
			if (!_oDialog) { _create(); }
			_aEntries = aEntries;
			_refresh();
			_oDialog.open();
		},

		/** Keeps an open dialog current when errors are captured or cleared. */
		update: function (aEntries) {
			_aEntries = aEntries;
			if (_oDialog && _oDialog.isOpen()) { _refresh(); }
		},

		close: function () {
			if (_oDialog && _oDialog.isOpen()) { _oDialog.close(); }
		},

		destroy: function () {
			if (_oDialog) { _oDialog.destroy(); }
			_oDialog = null;
			_oModel = null;
			_aEntries = [];
		}
	};
});
