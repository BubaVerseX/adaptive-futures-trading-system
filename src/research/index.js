"use strict";

module.exports = {
  ...require("./eventBacktester"),
  ...require("./historicalDataEngine"),
  ...require("./researchPlatform"),
  ...require("./strategyPlugins"),
};
