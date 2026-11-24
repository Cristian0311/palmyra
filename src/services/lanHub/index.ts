/**
 * Hub LAN: protocolo v1, firma de peticiones y handler framework-free.
 *
 * La conexión HTTP se cablea en otra capa; aquí solo viven el contrato del
 * cable y la lógica de emparejamiento, operaciones idempotentes y lectura de
 * cambios/snapshot.
 */
export * from "./protocol";
export * from "./auth";
export * from "./handler";
export * from "./nodeServer";
export * from "./client";
export * from "./hostRuntime";
export * from "./session";
export * from "./pairing";
export * from "./events";
export * from "./clientLoop";
