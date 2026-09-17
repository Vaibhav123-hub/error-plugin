sap.ui.define([
	"sap/ui/core/UIComponent",
	"error/capture/plugin/util/MessageInterceptor"
], function (UIComponent, MessageInterceptor) {
	"use strict";

	return UIComponent.extend("error.capture.plugin.Component", {

		metadata: {
			manifest: "json"
		},

		// FLP plugins are headless: they run once when the shell loads them and never render a view.
		init: function () {
			UIComponent.prototype.init.apply(this, arguments);

			var mErrorCaptureConfig = this.getManifestEntry("/sap.ui5/config/errorCapture") || {};
			MessageInterceptor.init(mErrorCaptureConfig);
		},

		exit: function () {
			MessageInterceptor.destroy();
			UIComponent.prototype.exit.apply(this, arguments);
		}
	});
});
