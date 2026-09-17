sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/m/MessageBox",
	"sap/m/MessageToast",
	"sap/ui/core/message/Message",
	"sap/ui/core/library"
], function (Controller, MessageBox, MessageToast, Message, coreLibrary) {
	"use strict";

	var MessageType = coreLibrary.MessageType;

	return Controller.extend("error.capture.plugin.test.demoapp.controller.Main", {

		onTriggerMessageBoxError: function () {
			MessageBox.error("Item 4711 could not be saved: backend returned HTTP 500.", {
				details: "Technical details: /sap/opu/odata/sap/DEMO_SRV/Items(4711) - Internal Server Error",
				messageCode: "DEMO/SAVE_FAILED"
			});
		},

		onTriggerMessageBoxWarning: function () {
			MessageBox.warning("Some line items have quantities exceeding available stock.");
		},

		onTriggerMessageToast: function () {
			MessageToast.show("Draft saved locally.");
		},

		onTriggerMessageManager: function () {
			sap.ui.getCore().getMessageManager().addMessages(
				new Message({
					message: "Quantity must be greater than zero",
					type: MessageType.Error,
					target: "/DemoModel/quantity",
					processor: new sap.ui.model.json.JSONModel({ quantity: 0 })
				})
			);
		},

		onTriggerJsError: function () {
			// intentionally reference an undefined variable to produce an uncaught TypeError
			// eslint-disable-next-line no-undef
			undefinedDemoFunction();
		}
	});
});
