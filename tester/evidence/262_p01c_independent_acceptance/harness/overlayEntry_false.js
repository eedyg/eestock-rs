var OverlayEntryFalse = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // ../../../../../../../tmp/p01c/mut/overlayIndicator_false.ts
  var overlayIndicator_false_exports = {};
  __export(overlayIndicator_false_exports, {
    addOverlayIndicator: () => addOverlayIndicator
  });
  function addOverlayIndicator(chart, spec, expectName) {
    chart.removeIndicator({ name: expectName });
    chart.createIndicator(spec, false);
    if (chart.getIndicators({ name: expectName }).length === 0) {
      throw new Error(`\u6307\u6807 ${expectName} \u672A\u751F\u6548\uFF08isStack \u8BED\u4E49\u5751\uFF09`);
    }
  }
  return __toCommonJS(overlayIndicator_false_exports);
})();
