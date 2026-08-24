import { render } from "preact";
import { RepositoryHomeApp } from "./screens/RepositoryHomeApp.js";
import "@vscode/codicons/dist/codicon.css";
import "./styles/repositoryHome.css";

const gitoRootElement = document.querySelector("#gito-root");
if (!(gitoRootElement instanceof HTMLElement))
  throw new Error("Git'o webview root was not found.");
render(<RepositoryHomeApp />, gitoRootElement);
