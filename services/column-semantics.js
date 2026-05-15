"use strict";

/**
 * Column names that are digit-like in data but must never be money/count/ratio
 * (postal codes, phones). Keep behaviour aligned with dashboard.html isNonAggregableDigitKey.
 */
function normalizeColKey(col) {
  return String(col || "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function looksLikePostalOrPinKey(col) {
  const k = normalizeColKey(col);
  if (!k) return false;
  if (k.includes("pincode") || k.includes("postcode") || k.includes("postalcode") || k.includes("zipcode")) return true;
  if (k.includes("postal") && k.includes("code")) return true;
  if (k === "zip" || k === "postal" || k.endsWith("zip")) return true;
  return false;
}

function looksLikePhoneOrMobileKey(col) {
  const k = normalizeColKey(col);
  if (!k || k.includes("microphone")) return false;
  if (k.includes("contactmobile") || k.includes("mobileno") || k.includes("phoneno")) return true;
  if (k.includes("phonenumber") || k.includes("cellphone") || k.includes("whatsapp")) return true;
  if (k.includes("telephone") || k.includes("telephoneno") || k.includes("telno")) return true;
  if (k.includes("landline") || k.includes("landlineno")) return true;
  if (k === "fax" || k.includes("faxno") || (k.startsWith("fax") && k.length <= 12)) return true;
  if (k.includes("workphone") || k.includes("homephone") || k.includes("officephone")) return true;
  if (k.includes("alternatemobile") || k.includes("primaryphone") || k.includes("secondaryphone")) return true;
  if (k.endsWith("mobile") && !k.includes("automobile")) return true;
  if (k === "mobile" || k === "phone" || k === "tel" || k === "sms") return true;
  return false;
}

function looksLikeInvoiceDocumentKey(col) {
  const k = normalizeColKey(col);
  if (!k) return false;
  if (
    /purinvoice|purinvno|invoiceno|invoiceid|billno|billnumber|billnum|cashmemono|memono|orderno|ordernumber|voucherno|grnno|ponumber|purchaseorder|challanno|purchallan|purchallanno|purrefno|documentno/.test(
      k
    )
  ) {
    return true;
  }
  return false;
}

/** Para1Index, Para2Index — sizing / lookup indexes, not additive measures */
function looksLikeParaIndexKey(col) {
  return /^para\d+index$/i.test(String(col || "").trim());
}

function isNonAggregableDigitColumnName(col) {
  return (
    looksLikePostalOrPinKey(col) ||
    looksLikePhoneOrMobileKey(col) ||
    looksLikeInvoiceDocumentKey(col) ||
    looksLikeParaIndexKey(col)
  );
}

module.exports = {
  normalizeColKey,
  looksLikePostalOrPinKey,
  looksLikePhoneOrMobileKey,
  looksLikeInvoiceDocumentKey,
  looksLikeParaIndexKey,
  isNonAggregableDigitColumnName,
};
