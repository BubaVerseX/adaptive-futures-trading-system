"use strict";

const STRATEGY_INTERFACE_METHODS = Object.freeze([
  "generateSignal",
  "generateExit",
  "positionSizing",
  "expectedHoldingTime",
  "expectedRewardRisk",
  "confidence",
  "marketCompatibility",
]);

class StrategyInterface {
  constructor(name) {
    if (!name) throw new Error("StrategyInterface requires a strategy name.");
    this.name = name;
  }

  generateSignal() {
    throw new Error(`${this.name}.generateSignal() must be implemented.`);
  }

  generateExit() {
    throw new Error(`${this.name}.generateExit() must be implemented.`);
  }

  positionSizing() {
    throw new Error(`${this.name}.positionSizing() must be implemented.`);
  }

  expectedHoldingTime() {
    throw new Error(`${this.name}.expectedHoldingTime() must be implemented.`);
  }

  expectedRewardRisk() {
    throw new Error(`${this.name}.expectedRewardRisk() must be implemented.`);
  }

  confidence() {
    throw new Error(`${this.name}.confidence() must be implemented.`);
  }

  marketCompatibility() {
    throw new Error(`${this.name}.marketCompatibility() must be implemented.`);
  }
}

function validateStrategyInterface(strategy) {
  if (!strategy || typeof strategy.name !== "string" || !strategy.name) {
    throw new Error("Strategy must expose a non-empty name property.");
  }
  for (const method of STRATEGY_INTERFACE_METHODS) {
    if (typeof strategy[method] !== "function") {
      throw new Error(`${strategy.name} must expose ${method}().`);
    }
  }
  return true;
}

module.exports = {
  STRATEGY_INTERFACE_METHODS,
  StrategyInterface,
  validateStrategyInterface,
};
