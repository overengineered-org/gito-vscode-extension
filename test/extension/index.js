const runExtensionHostSmoke = require("./extensionHostSmoke.test.js");

module.exports = {
  run(_testsRoot, callback) {
    runExtensionHostSmoke().then(
      () => callback(undefined, 0),
      (error) => callback(error, 1),
    );
  },
};
