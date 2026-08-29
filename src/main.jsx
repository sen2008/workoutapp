import React from "react";
import { createRoot } from "react-dom/client";
import Backlog from "./Backlog.jsx";
import "./index.css";

/*
 * The unlock page boots this bundle with document.write(), where the script tag
 * in <head> runs while the body is still being parsed — so #root does not exist
 * yet. Wait for the document either way: opened straight from dist/ the script
 * is deferred and the element is already there.
 */
function mount() {
  createRoot(document.getElementById("root")).render(<Backlog />);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
