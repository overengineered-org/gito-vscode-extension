import { rmSync } from "node:fs";
import { resolve } from "node:path";

for (const generatedDirectory of ["dist", ".integration-test"]) {
  rmSync(resolve(generatedDirectory), { force: true, recursive: true });
}
