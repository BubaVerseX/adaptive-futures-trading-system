"use strict";

module.exports = {
  ...require("./eventBacktester"),
  ...require("./historicalDataEngine"),
  ...require("./promotionOptimizer"),
  ...require("./researchPlatform"),
  ...require("./strategyPlugins"),
};
