/**
 * Regresiones del QR de acceso de equipo.
 *
 * Pedido del dueño: al generar el enlace de invitación de un trabajador debe
 * aparecer además un QR para escanear con otro dispositivo y entrar directo.
 * Dos decisiones que un refactor puede romper sin avisar:
 * - El QR codifica el enlace **https**, no el `palmyra://`: la cámara de un
 *   teléfono no abre esquemas propios y el enlace quedaría inservible.
 * - Se pinta sobre blanco fijo aunque la app esté en modo oscuro, porque un QR
 *   invertido o sobre violeta deja de ser escaneable para muchas cámaras.
 * Y el journey entero exige que `/device-access` se monte sin esperar el arranque
 * de la app: si se queda tras «Preparando PALMYRA…», quien escanea nunca ve el
 * activador.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(path, "utf8");

test("AccessQr usa el QR del bundle, sobre blanco y con el enlace https", () => {
  const component = source("src/components/AccessQr.tsx");
  assert.match(component, /import \{ QRCodeSVG \} from "qrcode\.react"/);
  assert.match(component, /bgColor="#FFFFFF"/);
  assert.match(component, /level="M"/, "corrección de errores media: legible con reflejos");
  assert.match(component, /marginSize=\{2\}/, "sin quiet zone la cámara no enmarca el código");
  assert.match(component, /bg-white/);
  // Sin dependencias nuevas: qrcode.react ya estaba para las etiquetas de inventario.
  const pkg = JSON.parse(source("package.json"));
  assert.ok(pkg.dependencies["qrcode.react"]);
});

test("AccessQr no rompe el modo oscuro ni renderiza nada vacío", () => {
  const component = source("src/components/AccessQr.tsx");
  assert.doesNotMatch(component, /bgColor=\{?"?var\(/, "el fondo del QR no puede ser un token temático");
  assert.match(component, /if \(!link \|\| tooLong\) return null/);
});

test("Team muestra el QR en las dos superficies del enlace de acceso", () => {
  const team = source("src/pages/Team.tsx");
  assert.match(team, /import AccessQr from "\.\.\/components\/AccessQr"/);
  assert.equal(
    (team.match(/<AccessQr /g) || []).length,
    2,
    "el QR va en la pestaña Acceso del editor y en el modal del enlace"
  );
  // Solo con enlace generado: antes de la respuesta del servidor no hay que codificar.
  assert.equal((team.match(/\{formAccessLink && \(/g) || []).length >= 1, true);
  // El modal muestra el QR o, si no hay enlace en claro, la lista del servidor.
  assert.match(team, /\{accessInvite\.link \? \(/);
  // El QR del modal no puede recibir el deep link: la cámara no abre palmyra://.
  assert.doesNotMatch(team, /<AccessQr value=\{buildDeviceAccessDeepLink/);
});

test("el enlace del QR apunta al origen público, no a 127.0.0.1", () => {
  const service = source("src/services/deviceAccess.ts");
  assert.match(service, /export function buildDeviceAccessLink\(token: string\): string \{/);
  assert.match(service, /shareableOrigin\(\)\}\/device-access\?token=/);
  assert.match(service, /if \(host === 'localhost' \|\| host\.endsWith\('\.localhost'\)\) return PALMYRA_REMOTE_ORIGIN/);
  assert.match(service, /\/\^127\\./);
});

test("/device-access se monta sin esperar la verificación de sesión", () => {
  const app = source("src/App.tsx");
  assert.match(app, /const isDeviceAccessPath = /);
  assert.equal(
    (app.match(/!isDeviceAccessPath/g) || []).length,
    3,
    "los tres bloqueos de arranque deben dejar pasar el activador"
  );
  assert.match(app, /path="\/device-access" element=\{<DeviceAccess \/>\}/);
});
