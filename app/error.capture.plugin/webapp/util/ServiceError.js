sap.ui.define([], function () {
	"use strict";

	// Turns a failed service call into the text a user (and Ask AI) can work with: the backend's own message where
	// the response has one, otherwise a plain-language description of the HTTP status.

	var HTTP_STATUS_TEXTS = [400, 401, 403, 404, 408, 409, 412, 413, 429, 500, 502, 503, 504];

	// Wrapper messages that say nothing about the actual problem - the specific message is in the details then.
	var GENERIC_MESSAGES = [
		/^an exception (was|has been) raised\.?$/i,
		/^exception raised without specific error\.?$/i,
		/unknown internal server error/i,
		/^(internal server )?error\.?$/i,
		/^an error (has )?occurred\.?$/i,
		/^multiple (errors|messages)( occurred)?\b/i,
		// a bare HTTP reason phrase says no more than the status itself
		/^(bad request|unauthorized|forbidden|not found|method not allowed|conflict|precondition failed|service unavailable|bad gateway|gateway time-?out)\.?$/i
	];

	// Path segments that only say "this is an OData service", not which one - left out of the call description
	var PATH_NOISE = /^(sap|opu|odata|odata4|srvd|srvd_a2x|v2|v4|\d{4})$/i;

	var SAP_MESSAGE_CODE = /^.+\/\d{3}$/;

	function _text(v) {
		if (v && typeof v === "object") { v = v.value; } // OData V2: message: { lang, value }
		return typeof v === "string" ? v.trim() : "";
	}

	function _isGeneric(sMessage) {
		return !sMessage || GENERIC_MESSAGES.some(function (oPattern) { return oPattern.test(sMessage); });
	}

	function _isSapCode(sCode) {
		return SAP_MESSAGE_CODE.test(String(sCode || "").trim());
	}

	// OData V2 error details: severity "error" / "warning" / "info" / "success"; OData V4: numericSeverity 1-4
	function _isErrorDetail(oDetail) {
		var vNumeric = oDetail["@Common.numericSeverity"] || oDetail["@com.sap.vocabularies.Common.v1.numericSeverity"];
		if (vNumeric !== undefined) { return Number(vNumeric) >= 4; }
		return !oDetail.severity || /^error$/i.test(oDetail.severity);
	}

	// Picks the most useful { message, code } from the top-level error and its details. A message that stays generic
	// is dropped (the code is kept), so the caller describes the failure from its HTTP status instead.
	function _choose(oTop, aDetails) {
		var aErrors = aDetails.filter(function (oDetail) { return oDetail.message && _isErrorDetail(oDetail); });
		var oResult = { message: oTop.message, code: oTop.code };
		if (_isGeneric(oTop.message)) {
			var oSpecific = aErrors.filter(function (oDetail) { return !_isGeneric(oDetail.message); })[0];
			if (oSpecific) { oResult = { message: oSpecific.message, code: oSpecific.code }; }
		}
		// Gateway sometimes puts a framework code on the top level and the application's message class/number on
		// the detail carrying the same text
		if (!_isSapCode(oResult.code)) {
			var oSameText = aErrors.filter(function (oDetail) { return oDetail.message === oResult.message && _isSapCode(oDetail.code); })[0];
			if (oSameText) { oResult.code = oSameText.code; }
		}
		if (_isGeneric(oResult.message)) {
			return oResult.code ? { code: oResult.code } : {};
		}
		return oResult;
	}

	function _fromJson(oJson) {
		var oError = oJson && (oJson.error || oJson["odata.error"]);
		if (oError && typeof oError === "object") {
			var aRawDetails = (oError.innererror && oError.innererror.errordetails) || oError.details || [];
			var aDetails = (Array.isArray(aRawDetails) ? aRawDetails : []).map(function (oDetail) {
				return Object.assign({}, oDetail, { message: _text(oDetail.message), code: oDetail.code });
			});
			return _choose({ message: _text(oError.message), code: oError.code }, aDetails);
		}
		if (oJson && typeof oJson.message === "string") { // plain JSON error, e.g. from a REST service
			return _choose({ message: oJson.message.trim(), code: oJson.code }, []);
		}
		return {};
	}

	function _decodeXml(s) {
		return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
			.replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
			.replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(Number(d)); })
			.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
			.replace(/&amp;/g, "&")
			.trim();
	}

	function _xmlElement(sXml, sName) {
		var oMatch = new RegExp("<(?:[\\w-]+:)?" + sName + "(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?" + sName + ">", "i").exec(sXml);
		return oMatch ? _decodeXml(oMatch[1]) : "";
	}

	// OData V2 XML error: <error><code/><message/><innererror>...<errordetails><errordetail>... (any namespace prefix)
	function _fromXml(sBody) {
		if (!/<(?:[\w-]+:)?error[\s>]/i.test(sBody)) { return {}; }
		var iInner = sBody.search(/<(?:[\w-]+:)?innererror[\s>]/i);
		var sTop = iInner === -1 ? sBody : sBody.slice(0, iInner);
		var aDetails = [];
		var oDetailPattern = /<(?:[\w-]+:)?errordetail(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?errordetail>/gi;
		var oMatch;
		while ((oMatch = oDetailPattern.exec(sBody)) !== null) {
			aDetails.push({
				code: _xmlElement(oMatch[1], "code"),
				message: _xmlElement(oMatch[1], "message"),
				severity: _xmlElement(oMatch[1], "severity")
			});
		}
		return _choose({ message: _xmlElement(sTop, "message"), code: _xmlElement(sTop, "code") }, aDetails);
	}

	// What was called, without keys or query options (which can carry business data): the last two meaningful path
	// segments, e.g. "/sap/opu/odata/sap/ZSD_SRV/Orders(4711)?$top=5" -> "ZSD_SRV/Orders". $batch/$count/$value and
	// generic OData path parts (PATH_NOISE) are left out.
	function _resource(sUrl) {
		var sPath;
		try {
			sPath = new URL(sUrl).pathname;
		} catch (e) {
			sPath = String(sUrl).split(/[?#]/)[0];
		}
		var aSegments = sPath.split("/").filter(Boolean).map(function (sSegment) {
			try { sSegment = decodeURIComponent(sSegment); } catch (e) { /* keep as is */ }
			return sSegment.replace(/\(.*$/, "");
		}).filter(function (sSegment) { return sSegment && sSegment.charAt(0) !== "$" && !PATH_NOISE.test(sSegment); });
		return aSegments.slice(-2).join("/");
	}

	return {

		/** i18n keys of the HTTP status descriptions, for the caller to resolve */
		TEXT_KEYS: HTTP_STATUS_TEXTS.map(function (iStatus) { return "httpError" + iStatus; })
			.concat(["httpError4xx", "httpError5xx", "httpErrorNetwork"]),

		/**
		 * The backend's message for the user from an error response body: OData V2 (JSON or XML, incl. Gateway
		 * errordetails), OData V4 (incl. details, e.g. RAP or CAP) or plain JSON. Generic wrapper messages are
		 * replaced by the first specific error in the details.
		 * @param {string} sBody response body
		 * @returns {{message: string, code: string}|{}} empty object if the body has no usable message
		 */
		extract: function (sBody) {
			if (!sBody || typeof sBody !== "string") { return {}; }
			var sTrimmed = sBody.trim();
			if (sTrimmed.charAt(0) === "{") {
				try {
					return _fromJson(JSON.parse(sTrimmed));
				} catch (e) {
					return {};
				}
			}
			if (sTrimmed.charAt(0) === "<" && !/^<!doctype html|^<html/i.test(sTrimmed)) {
				return _fromXml(sTrimmed);
			}
			return {}; // HTML error pages, plain text: technical, described from the status instead
		},

		/**
		 * Plain-language description of a failed call without a backend message, e.g.
		 * "The requested data or service was not found. (HTTP 404, GET DemoService/Orders)".
		 * @param {{status: int, method: string, url: string, batch: boolean}} mRequest the failed call
		 * @param {object} mTexts resolved texts for TEXT_KEYS
		 * @returns {string} the description
		 */
		describe: function (mRequest, mTexts) {
			var iStatus = mRequest.status;
			var sText = !iStatus ? mTexts.httpErrorNetwork
				: mTexts["httpError" + iStatus] || (iStatus >= 500 ? mTexts.httpError5xx : mTexts.httpError4xx);
			var sCall = mRequest.method + " " + _resource(mRequest.url) + (mRequest.batch ? " ($batch)" : "");
			return sText + " (" + (iStatus ? "HTTP " + iStatus + ", " : "") + sCall + ")";
		}
	};
});
