import { render } from "preact";

import { GraphExperienceApp } from "./GraphExperienceApp.js";
import "./graph.css";

const graphRootElement = document.querySelector("#gito-graph-root");
if (!(graphRootElement instanceof HTMLElement))
  throw new Error("Git'o graph webview root was not found.");
render(<GraphExperienceApp />, graphRootElement);
