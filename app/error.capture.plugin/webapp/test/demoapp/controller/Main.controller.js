sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/m/MessageBox",
	"sap/ui/core/message/Message",
	"sap/ui/core/library"
], function (Controller, MessageBox, Message, coreLibrary) {
	"use strict";

	var MessageType = coreLibrary.MessageType;

	return Controller.extend("error.capture.plugin.test.demoapp.controller.Main", {

		// error dialog with a SAP message code - Ask AI receives message_id M3 / message_number 305
		onTriggerMessageBoxError: function () {
			MessageBox.error("Material 4711 does not exist", {
				messageCode: "M3/305"
			});
		},

		onTriggerMessageBoxWarning: function () {
			MessageBox.warning("Some line items have quantities exceeding available stock.");
		},

		// confirmation dialogs are questions, not errors - no Ask AI button expected
		onTriggerMessageBoxConfirm: function () {
			MessageBox.confirm("Do you want to discard your changes?");
		},

		// no dialog: only the launchpad header's Ask AI button offers it
		onTriggerMessageManager: function () {
			sap.ui.getCore().getMessageManager().addMessages(
				new Message({
					message: "Enter a quantity greater than zero",
					code: "V1/023",
					type: MessageType.Error,
					target: "/DemoModel/quantity",
					processor: new sap.ui.model.json.JSONModel({ quantity: 0 })
				})
			);
		},

		// failed service call the app handles quietly - header button only
		onTriggerFailedCall: function () {
			fetch("./odata/DemoService/Orders(4711)").catch(function () { /* handled by the "app" */ });
		},

		onTriggerJsError: function () {
			// intentionally reference an undefined variable to produce an uncaught TypeError
			// eslint-disable-next-line no-undef
			undefinedDemoFunction();
		}
	});
});
