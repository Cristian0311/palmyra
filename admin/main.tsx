import React from "react";
import { createRoot } from "react-dom/client";
import AdminApp from "./AdminApp";

const root = document.getElementById("admin-root");

if (!root) {
  throw new Error("No se encontró #admin-root.");
}

createRoot(root).render(
  <React.StrictMode>
    <AdminApp />
  </React.StrictMode>,
);
