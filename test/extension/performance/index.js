const runPackagedPerformance = require("./packaged-performance.test.js");

module.exports = {
  run(_testsRoot, callback) {
    runPackagedPerformance().then(
      () => callback(undefined, 0),
      (error) => callback(error, 1),
    );
  },
};
