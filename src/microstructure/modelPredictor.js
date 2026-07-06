"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function readJson(file, fallback = null) {
  if (!file || !fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadMicroModelManifest(config = {}) {
  return readJson(config.microModelManifestFile, null);
}

function modelForHorizon(manifest = {}, horizonSeconds) {
  const models = Array.isArray(manifest.models) ? manifest.models : [];
  return models.find((model) => Number(model.horizonSeconds) === Number(horizonSeconds)) || models[0] || null;
}

function microModelStatus(config = {}) {
  const manifest = loadMicroModelManifest(config);
  if (!manifest) {
    return { ready: false, status: "MICRO_MODEL_NOT_READY", reason: "MODEL_MANIFEST_MISSING" };
  }
  const model = modelForHorizon(manifest, config.microPredictionHorizonSeconds);
  const modelPath = model && path.resolve(config.projectRoot || process.cwd(), model.modelFile || model.model || "");
  if (manifest.status !== "TRAINED" || !model || !modelPath || !fs.existsSync(modelPath)) {
    return {
      ready: false,
      status: "MICRO_MODEL_NOT_READY",
      reason: "TRAINED_MODEL_FILE_MISSING",
      manifestStatus: manifest.status,
    };
  }
  return {
    ready: true,
    status: "MICRO_MODEL_READY",
    manifest,
    model,
    modelPath,
  };
}

function predictWithTrainedMicroModel(snapshot = {}, config = {}) {
  const status = microModelStatus(config);
  if (!status.ready) return { ready: false, error: status.reason, status };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "micro-predict-"));
  const featureFile = path.join(tempDir, "features.json");
  fs.writeFileSync(featureFile, `${JSON.stringify({ features: snapshot.features || {} })}\n`, "utf8");
  const script = path.join(config.projectRoot || process.cwd(), "python", "microstructure", "predict_micro_signal.py");
  const python = config.microPythonBin || process.env.PYTHON || "python3";
  const result = spawnSync(python, [script, "--model", status.modelPath, "--features", featureFile], {
    cwd: config.projectRoot || process.cwd(),
    encoding: "utf8",
    timeout: config.microPredictionTimeoutMs || 5000,
  });
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (result.error || result.status !== 0) {
    return {
      ready: false,
      error: result.error ? result.error.message : result.stderr || result.stdout,
      status,
    };
  }
  try {
    return {
      ready: true,
      prediction: JSON.parse(result.stdout),
      status,
    };
  } catch (error) {
    return { ready: false, error: error.message, status };
  }
}

module.exports = {
  loadMicroModelManifest,
  microModelStatus,
  predictWithTrainedMicroModel,
};
