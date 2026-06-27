const fs = require("node:fs");
const path = require("node:path");

const reportPath = path.join(__dirname, "..", "data", "reliability-report.json");

function readReliabilityReport() {
  try {
    return JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch {
    return {
      updatedAt: "",
      suites: {}
    };
  }
}

function writeReliabilitySuite(name, payload) {
  const report = readReliabilityReport();
  const nextReport = {
    ...report,
    updatedAt: new Date().toISOString(),
    suites: {
      ...(report.suites || {}),
      [name]: {
        ...payload,
        updatedAt: new Date().toISOString()
      }
    }
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(nextReport, null, 2)}\n`);
  return nextReport;
}

module.exports = {
  writeReliabilitySuite
};
