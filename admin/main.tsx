import React from "react";
import { createRoot } from "react-dom/client";
import AdminApp from "./AdminApp";
import { mountAdminUpdateBanner, startAdminUpdateWatcher } from "./adminUpdate";

const root = document.getElementById("admin-root");

if (!root) {
  throw new Error("No se encontró #admin-root.");
}

startAdminUpdateWatcher((build) => mountAdminUpdateBanner(build));

createRoot(root).render(
  <React.StrictMode>
    <AdminApp />
  </React.StrictMode>,
);
