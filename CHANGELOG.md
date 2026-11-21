# CHANGELOG — PALMYRA POS

## 1.3.1 — Registro y confirmación de correo sin errores

### Confirmación por correo
- La plantilla enviada por Supabase vuelve a mostrar el **logo oficial de
  PALMYRA** (`palmyra-email-logo-v2.png`) y ahora está rediseñada con la
  identidad violeta, el correo del destinatario y un enlace de respaldo.
- El botón «Confirmar» ya no responde «el enlace no es válido»: la página
  `/auth/confirm` prueba `email`, `signup`, el token antiguo y el código PKCE,
  y si el enlace ya se consumió pero la cuenta quedó confirmada, deja entrar.
- Si el enlace caducó de verdad, la misma página ofrece **reenviar el correo**
  sin salir de ella.
- Los asuntos del correo quedan en español:
  «Confirma tu cuenta PALMYRA» y «Restablece tu contraseña PALMYRA».

### Flujo de registro
- Tras crear la cuenta se muestra un panel **«Revisa tu correo»** con el
  correo usado, los 3 pasos, cuenta atrás para reenviar, «Ya confirmé · Entrar»
  y «Usar otro correo».
- El registro valida el correo y la confirmación de contraseña antes de enviar,
  y avisa cuando el correo ya tiene una cuenta PALMYRA.
- Iniciar sesión con un correo sin confirmar ofrece reenviar la confirmación.

### Onboarding
- Quien ya tiene una empresa **no vuelve a ver la configuración inicial**:
  al confirmar se consulta la membresía y se entra directo al panel; si la
  empresa está pendiente va a «Estado de la cuenta».
- Después de confirmar se abre el onboarding con los **cuatro planes** reales
  (Gratis, Oasis, Caravana, Ciudadela) en tarjetas PALMYRA con límites,
  prestaciones, duración, forma de pago y resumen fijo.
- El plan elegido en el landing se conserva durante el viaje al correo.

### Correcciones
- Logo: atributos SVG en camelCase y IDs de título/descripción únicos por copia
  (React dejaba de avisar de propiedades inválidas).

## 1.2.0 — Turnos, auditorías, bancos y Android

### Inventario
- La tarjeta de producto ya no muestra el «total de stock en dinero» bajo el
  precio; queda solo precio y ganancia por unidad.

### Auditoría de inventario
- Se puede **eliminar una auditoría** que aún no aplicó ajustes (desde la
  lista y desde el detalle), también offline: la operación viaja en la cola y
  la RPC `palmyra_delete_audit` conserva las auditorías aprobadas.
- Se retira el **conteo a ciego**: el conteo siempre muestra la referencia.
  Las auditorías antiguas también se abren con la referencia visible.
- La cabecera y los textos de la pantalla ya no se cortan en pantallas
  pequeñas: tipografía adaptativa y nombres con salto de línea.

### Reportes y nómina
- «Ocultar» y «Eliminar» en el detalle del turno aplican al **turno completo**,
  no a un ticket suelto; cada ticket conserva solo «Ver comprobante».
- Corregido «Se requiere actualizar el RPC de anulación de turno»: la RPC
  acepta turnos abiertos y cerrados y devuelve `voided_sale_ids` para que el
  POS purgue exactamente las ventas anuladas y reponga el stock.
- La pestaña **Nómina** ya no muestra información de descuadre ni botones de
  ocultar/eliminar turno.

### Bancos y POS
- «Detalle» ya no parte códigos largos: la referencia se trunca en el medio
  con «Ver más» y cada movimiento enlaza a su **venta del POS** y turno.
- Al cerrar la caja, el POS muestra automáticamente el resumen del turno con
  los **cobros bancarios** (banco, referencia y total por moneda).
- Alertas de divisas: umbral configurable en **porcentaje o monto fijo**
  (por ejemplo, avisar si la tasa sube o baja 5 pesos).

### Red local, rendimiento y Android
- «Máquinas conectadas» muestra el **nombre real**: modelo del móvil
  (p. ej. SM-A536B), nombre de la PC (hostname/DNS inverso) y su plataforma.
  El nombre manual sigue mandando y se marca «Detectado» el automático.
- En Android se recomienda instalar el **APK** al entrar desde la web, incluso
  con la PWA instalada, con opción «Más tarde» y «No volver a mostrar».
- Burbujas de carga: las operaciones lentas (sincronización manual, cierre de
  turno, procesos de nube) muestran «Cargando…» con spinner hasta terminar.
- APK reparado: `resources.arsc` se empaqueta sin comprimir y alineado, el
  artefacto se firma tras zipalign 16 KB y se publica como
  `PALMYRA-Android.apk` para que la descarga del landing instale sin errores.

## 1.1.0 — Auditoría total de los 7 frentes y correcciones solicitadas

### Inventario
- La ganancia real por producto se muestra por unidad (`Ganancia/u` = precio de
  venta − costo − salario/comisión del producto) y el total del stock actual en
  una segunda línea; la tarjeta «Ganancia real» explica la fórmula en su
  tooltip. Los valores negativos se pintan en rojo.

### Reportes
- El detalle de cada turno en Ventas conserva las acciones «Ocultar venta» y
  «Eliminar venta» con su reintegro de stock.

### POS / Cotizaciones
- Si una cotización enviada al POS se elimina, al abrir el POS su carrito ya no
  reaparece: el ticket se vacía y el aviso persistente desaparece.

### Planes y pago
- PayPal se elimina de todo el sistema. Solo se aceptan efectivo en CUP,
  transferencia bancaria en CUP y efectivo en USD, con confirmación manual.
- El seguimiento de Facebook y del canal de WhatsApp deja de pedirse en el
  registro y pasa a la selección de plan: el plan Gratis permanece bloqueado
  hasta pulsar ambos botones y completar una verificación de 5 segundos.

### Landing
- La paleta de colores deja de mostrar etiquetas de 6 px pegadas: ahora es una
  rejilla con nombres legibles y el código HEX de cada tono.
- La nota de planes lista los métodos de pago vigentes y las tarjetas de PC y
  Android descargan los artefactos del servidor de producción.

### Menú lateral
- El badge del plan ya no se pinta mientras el perfil/plan está cargando (antes
  todas las secciones aparecían «bloqueadas» y el texto tapaba el nombre).
- El badge pasa a una línea propia bajo el nombre de la sección, con icono de
  candado y tamaño legible; la barra ajusta sus anchos por punto de ruptura.

### Bancos
- En móvil la referencia de cada movimiento se muestra en una sola línea con
  «…» y un enlace «Ver más / Ver menos», para que el historial no ocupe tanto
  espacio y siga siendo legible.

### Panel administrativo
- Empresas muestra estado de cuenta, plan y vencimiento; la aprobación de
  pagos exige importe recibido, moneda y referencia. Soporte permite marcar
  «En proceso» y «Resolver». Configuración guarda WhatsApp, correo,
  privacidad, Facebook y canal de WhatsApp.
- Las acciones usan RPCs `security definer` con pertenencia a
  `platform_admins`; se retiró la sobrecarga ambigua de settings.
- Nueva migración `20261120121000_platform_admin_console.sql` con
  `get_platform_companies`, `set_platform_company_status` y
  `set_platform_support_request_status`.

### Base de datos
- El plan Gratis conserva sus límites y ahora incluye respaldo comercial en la
  nube (`20261120120000_free_plan_cloud_backup.sql`). Aplicado en producción
  el 2026-11-20 sin alterar empresas, suscripciones, solicitudes, facturas ni
  pagos existentes.

### Offline
- La reconciliación de recepciones de proveedor consulta `purchase_orders`
  (la tabla `supplier_orders` no existe en la base) y traduce `ordered` →
  `pending`; deja de fallar al volver la conexión.
- El aviso de cierre de sesión con la cola pendiente explica que el envío
  requiere volver a entrar con internet.
- `android/build-apk.sh` copia automáticamente `dist` a `assets/web` antes de
  empaquetar, así el APK nunca publica un shell viejo.
- El smoke offline reemplaza la comprobación del modal de cierre huérfano por
  la ruta Tutorial precacheada.

## 1.0.26 — APK real, accesos directos desde el landing y legibilidad auditada

### Móvil Android (APK nativa)
- Se publica un APK real (sin depender de PWA): la web compilada viaja dentro
  de la app y se sirve en `127.0.0.1:45643` con NanoHTTPD, así conserva
  origen seguro (service worker, localStorage, IndexedDB) y funciona sin
  internet.
- La tarjeta de móvil del landing descarga directamente el APK más reciente
  desde `/download/android`; la instalación por navegador (PWA) queda como
  opción secundaria y en iPhone/iPad se explica que no aceptan APK.
- `android/build-apk.sh` compila el APK con las build-tools del SDK
  (aapt2 + javac + d8 + apksigner) sin depender de Gradle.

### Landing con accesos reales
- Cada área del mapa abre la sección real del software con «Abrir …»
  (Dashboard, POS, Inventario, Caja, Reportes, Clientes, Proveedores, Bancos,
  Equipo). Si no hay sesión, PALMYRA pide entrar.
- El centro de descargas muestra la versión actual instalada (v1.0.26) en la
  tarjeta de PC.

### Plan Gratis ligado a seguir a PALMYRA
- El registro en línea exige marcar el compromiso de seguir la página de
  Facebook o el canal de WhatsApp de PALMYRA.
- La pantalla de empresa (onboarding) pide la misma confirmación antes de
  crear la empresa con el plan Gratis y enlaza directamente a Facebook o al
  canal; la elección se guarda en el borrador local.

### Proveedores en lista
- La sección Proveedores pasa de tarjetas a una lista densa con encabezado
  (Proveedor, Contacto, Suministra, Órdenes, Acciones), búsqueda, orden A–Z y
  contador de resultados; en móvil se apila sin perder las acciones.

### Legibilidad
- El token de texto atenuado sube de contraste (`--text-muted`) para cumplir
  AA sobre fondos claros y sutiles, tanto en tema claro como oscuro.
- Las lecciones del tutorial crecen a 24 y el Centro de ayuda refleja el
  conteo y los nuevos temas (auditoría, tasa de cambio, soporte, descargas
  LAN).

### Datos y red
- Se añade la función `get_verified_exchange_rate_history` en Supabase para
  el historial de tasa verificada.
- Verificado el funcionamiento por LAN (`http://<IP>:45643`) y sin internet.

## 1.0.25 — Auditorías que sí ajustan stock e inventario a prueba de errores

### Auditorías
- Aprobar una auditoría ahora aplica de verdad el ajuste de stock: cada
  diferencia se publica por variante con la operación idempotente de ajuste y
  queda en cola si no hay conexión, así que se sincroniza al reconectar sin
  duplicar movimientos.
- Si la aprobación se hizo offline y luego llega la nube con estados viejos,
  la app ya no la sobrescribe: se conservan la aprobación local, sus conteos
  por variante y la marca de ajuste publicado.
- El detalle de la auditoría muestra variantes, conteos nulos y estados
  («pendiente de aprobación», «reconteo solicitado») de forma consistente
  entre lo local y lo que baja de Supabase.

### Inventario
- Editar varios productos en masa guarda aunque no haya red: cada cambio se
  encola y se publica al reconectar; el resultado indica cuántos quedaron
  pendientes.
- Un producto ya no puede tener tallas y colores a la vez: el paso de
  variantes bloquea el segundo eje y explica que cada etiqueta tendrá su
  propio stock (evita stock fantasma en el POS).
- Agregar un producto con SKU o código de barras repetido avisa en vez de
  descartarlo en silencio.
- Eliminar una categoría en uso queda bloqueado con un aviso que dice cuántos
  productos la usan.
- Las confirmaciones de eliminación de productos y categorías usan un diálogo
  propio de PALMYRA en lugar del confirmador del navegador.
- Los indicadores (unidades, productos, bajo stock, ganancia) ahora respetan
  el almacén seleccionado y ya no desaparecen al filtrar la tabla.
- La etiqueta «NETO» pasa a «Ganancia» para que se entienda de inmediato.
- El umbral de «bajo stock» es el mismo en todos los módulos: alerta del
  producto, mínimo del nivel o 5 por defecto.

### Permisos y alcance por almacén
- Inventario y Transferencias muestran únicamente los almacenes autorizados
  al usuario y ajustan los filtros y el formulario de traslado a ese alcance.

### Transferencias
- Crear un traslado desde el modo offline descuenta solo el origen: el destino
  se acredita al recibir, evitando duplicar unidades en tránsito.

### Reportes
- El análisis ABC deja fuera ventas anuladas, reembolsadas y ocultas del
  reporte, igual que el reporte de ventas.

## 1.0.24 — Tasa de cambio viva, soporte directo y traslados más claros

### Tasa de cambio
- Rediseño completo al estilo PALMYRA: cabecera con mercado y fuente, tira de
  estado con conexión en vivo, última consulta guardada y cuenta atrás para la
  próxima actualización.
- Tarjetas por divisa con valor grande, variación con flecha (sube/baja),
  minigráfico de las últimas consultas y chips de compra/venta.
- Gráfico principal con pestañas 24 h / 7 d / 30 d / histórico, estadísticas de
  actual, mínimo, máximo y número de consultas, más el historial detallado.
- Aviso claro cuando falta la credencial de elTOQUE en el servidor y bloqueo de
  reintentos en bucle; los datos guardados se muestran sin inventar valores.

### Soporte
- Centro de ayuda reescrito: hero «¿En qué te ayudamos?», accesos directos a
  WhatsApp y correo, buscador de preguntas frecuentes y secciones de tutorial,
  seguridad y privacidad con navegación propia.
- Formulario de solicitud con panel de contexto (empresa, versión, conexión y
  operaciones pendientes) y botón para copiar el diagnóstico, sin exponer datos
  sensibles.
- La solicitud se guarda aunque no haya conexión y ofrece continuar por
  WhatsApp cuando está configurado.

### Transferencias
- La tabla separa «Ruta» (origen → destino) y «Cantidad» (unidades y sentido)
  en columnas propias, también en la vista móvil.
- «Nuevo traslado» aprovecha todo el ancho: el catálogo de productos crece en
  pantallas grandes y se adapta a 5 tamaños de rejilla; la lista de envío
  acompaña la altura del panel.
- Verificado el flujo de eliminación de ventas en Reportes: al confirmar con
  motivo se elimina el registro y todos los productos (incluidas variantes y
  kits) vuelven al almacén correcto, con el cobro bancario revertido.

## 1.0.23 — Equipo rediseñado e identidad por trabajador

### Equipo
- Nueva cabecera con estado real del negocio (en línea / sin conexión), plan
  actual, uso de plazas con medidor y pila de avatares del personal.
- Cada trabajador tiene su avatar propio y determinista (iniciales + color)
  en la lista, en el modal, en el selector de empleado del POS y en las cajas
  abiertas, con punto de estado: en turno, invitación pendiente o inactivo.
- Indicadores de empleados activos, en turno, acceso web e invitaciones, más
  filtro por estado «En turno ahora» y resultados con conteo.
- Tarjeta «Varios equipos, una sola empresa» que enlaza al acceso LAN en
  Configuración para trabajar desde móviles, tablets y PC del mismo Wi-Fi.
- Las plazas y el plan se calculan con el plan real; la creación de roles
  personalizados exige Oasis y el aviso nombra el plan correspondiente.
- Los roles muestran permisos legibles agrupados por módulo con acciones
  «Todo / Quitar todo» por grupo.
- La eliminación de un trabajador usa un diálogo propio en lugar del
  confirmador del navegador.
- La sección es responsiva y respeta los temas claro y oscuro.

### Cotizaciones en POS
- Al cargar una cotización, el POS muestra un aviso fijo «Cotización cargada»
  con sus artículos y total, tanto en la burbuja de apertura de caja como en
  el ticket de venta; ya no depende de un mensaje temporal.
- El aviso permite cancelar la cotización en dos pasos; el ticket queda vacío
  y la cotización sigue disponible en Cotizaciones.
- El aviso desaparece solo cuando la cotización se cobra o se elimina, o
  cuando el ticket queda vacío, por lo que una cotización nunca se queda
  «en el aire».

## 1.0.22 — Caja POS, cancelación sin rastro y cierre reorganizado

### Apertura de caja
- El selector de empleado ordena primero a quien ya tiene una caja abierta,
  muestra su sucursal y, al elegirlo, abre directamente el formulario de
  reanudación con la contraseña.
- La tarjeta de apertura muestra el nombre de la sucursal del turno en curso
  y un acceso «Caja abierta · Reanudar turno» cuando corresponde.
- El formulario de movimiento conserva el tipo y la moneda tras registrar un
  egreso, para capturar varios gastos seguidos sin repetir la selección.

### Arqueo y cierre
- La pestaña de cierre se reorganizó en tres pasos: resumen calculado del
  turno, arqueo de efectivo con cuadre en vivo y fecha/liquidación.
- «Cuadre perfecto» ahora está al final del arqueo, junto a los conteos, y
  rellena cada moneda y transferencia con lo esperado antes de cerrar.
- El cierre resume fondo inicial, ventas, egresos e ingresos, y una nota
  aclara que el inventario ya se descontó al cobrar cada ticket.
- Los acentos del módulo de caja se unificaron al violeta de PALMYRA.

### Cancelar turno
- Eliminar un turno no deja ningún registro: se borran el turno, sus tickets y
  su liquidación local, y el servidor filtra los turnos anulados para que no
  reaparezcan en caja ni en reportes.
- Si la reversión bancaria local no puede aplicarse, la eliminación continúa y
  la conciliación se completa con Supabase.
- El modal explica las consecuencias y usa el color de peligro real.

### Inventario
- Nuevas pruebas confirman que el stock se descuenta una sola vez por venta,
  nunca baja de cero, respeta variantes y descuenta los componentes de un kit.

### Configuración y notificaciones
- La configuración ocupa el ancho disponible en PC (hasta 1600 px) con la
  navegación horizontal de secciones y flechas de desbordamiento.
- En modo local, Notificaciones explica el estado con un aviso neutro en lugar
  de un error de sesión.

## 1.0.21 — Auditoría visual de Configuración y Notificaciones

### Configuración
- Revisión completa de todos los flujos: menú lateral compacto de una línea,
  cabeceras idénticas por sección, controles en minúscula natural (14 px),
  botones de 44 px y acciones primarias violeta / destructivas rosa.
- Almacenes y Categorías: los botones de editar y eliminar ahora tienen área
  táctil de 44 px y los campos de alta comparten altura con su botón.
- Monedas y tasas: tarjetas compactas y alineadas, el estado base usa un chip
  neutro y los códigos mantienen la tipografía de 14 px.
- La página de tasas adopta el mismo encabezado tipo kicker del resto del
  sistema, sin tamaños heredados de 10 px.

### Salud local y Red local
- Un único botón de sincronización: el de la cabecera; se eliminó el duplicado.
- Columnas sin estiramiento artificial, jerarquía uniforme en las métricas y
  botones de reintentar/descartar de 44 px con etiquetas accesibles.
- Superficies 100 % con tokens del tema (sin blanco fijo ni grises sueltos en
  modo oscuro).

### Notificaciones
- La página usa el mismo shell de Configuración: cabecera neutra, tarjetas con
  borde, indicadores en chips y acciones violeta. Se retiraron el degradado y
  los acentos verdes fuera de los mensajes semánticos.
- Estado del push dentro de la tarjeta del móvil, sin recortes en pantallas
  pequeñas; textos profesionales y consistentes.

## 1.0.20 — Configuración reorganizada, tasas automáticas y red local

### Configuración
- Nueva estructura en tres grupos (Negocio, Ventas y caja, Sistema) con menú
  lateral fijo, dos columnas en móvil y una en PC, cabecera propia por sección
  y el mismo lenguaje visual violeta del resto del sistema.
- La sección de monedas vive ahora solo en «Monedas y tasas»; desapareció del
  bloque de apariencia.
- Todos los interruptores son accesibles: área táctil de 44 px, estado visible
  con y sin conexión, y etiqueta de lectura para lectores de pantalla.

### Monedas y tasas
- Nuevo interruptor «Actualizar automáticamente con elTOQUE». Cuando está
  activo, PALMYRA aplica la tasa publicada solo si el dato tiene menos de
  30 minutos y el cambio real alcanza el umbral configurado (5 CUP por defecto,
  ajustable entre 1 y 500). Así las tasas manuales no se mueven por variaciones
  mínimas.
- La tasa manual sigue disponible: el usuario puede escribir USD/EUR, guardar y
  el modo automático respeta el umbral en cada comprobación.
- Estado de la última comprobación, hora del dato, botón «Comprobar ahora» e
  historial en la página de tasas.

### Impresora y comprobantes
- Tarjeta de conexión con botones «USB / Serie», «Bluetooth» e «Imprimir
  prueba», con mensajes de estado y aviso cuando se abre dentro de un marco.
- Se mantienen el ancho, el pie del ticket y la reconexión automática.

### Red local
- Nueva sección «Red local»: muestra la dirección para abrir PALMYRA desde otros
  equipos, el puerto, el QR de acceso y la lista de máquinas conectadas con su
  nombre, tipo, IP, almacén y última señal.
- Los equipos se pueden renombrar o retirar de la lista; el nombre del equipo
  actual se guarda en este dispositivo. Los equipos dejan de listarse tras
  7 días sin señal.

## 1.0.19 — Transferencias por sucursal, cotizaciones cobrables y menú adaptable

### Transferencias
- Nuevo selector «Historial general / Por sucursal»: el historial se puede ver
  completo o solo el de una sucursal (movimientos de origen y de destino).
- Cada operación muestra dirección (Entrada/Salida), ruta, cantidad y productos;
  las operaciones por lotes se agrupan y se pueden expandir.
- Burbujas propias por modo: en modo sucursal se ven Operaciones, Unidades,
  Salidas y Entradas; en modo general, Operaciones, Unidades, En tránsito y
  Sucursal más activa.
- Tabla en PC y tarjetas apiladas en móvil, con búsqueda por producto, lote o
  sucursal. Los nombres largos se ajustan en varias líneas en lugar de cortarse.
- Vista de nuevo traslado más clara: origen, destino, stock disponible por
  producto y lista de envío con cantidades editables y confirmación.

### Menú lateral (sidebar)
- Se puede plegar y recuerda la elección entre sesiones; en modo plegado muestra
  iconos con acceso a sincronización, usuario y salir.
- Ancho adaptativo de 1024 a 1440 px sin espacios muertos; etiquetas y tarjeta
  del plan se ajustan en varias líneas.
- Corregido el logo del menú: el camello del wordmark no se dibujaba en PC
  porque dos copias del logo compartían los identificadores del degradado.

### Iconos y logo
- Se sustituyeron emojis por iconos del sistema en caja (pagos, filtros y
  desglose por producto) y en etiquetas de Reportes.
- Logos de acceso, invitación y registro conservan su proporción real; se
  verificaron los iconos PWA (192, 512, maskable y apple-touch).

### Cotizaciones
- El botón «TPV» pasa a «Cobrar en POS»: abre el Punto de Venta, el empleado
  elige su nombre y almacén, y los productos de la cotización se cargan solos
  en el carrito.
- Los campos de cantidad y precio permiten seleccionar todo el número,
  borrarlo y escribir otro sin saltos; los totales se recalculan al instante.
- Las cotizaciones se pueden eliminar (con confirmación) también sin conexión:
  el borrado se envía a la nube al sincronizar y no reaparece.
- Listado con tarjetas en móvil, acciones completas (ver, PDF, duplicar,
  eliminar, cobrar) y plurales correctos («1 artículo», «1 línea»).

## 1.0.18 — Detalle de venta, descuadres en lista y bancos por turno

### Detalle de venta (Reportes)
- El comprobante de venta ahora tiene acciones fijas al pie, siempre visibles:
  «Imprimir», «Editar fecha», «Ocultar venta», «Cerrar» y un botón completo
  «Eliminar venta» con explicación de lo que hace cada uno.
- Eliminar una venta borra el ticket, sus cobros y sus registros asociados, y
  devuelve los productos vendidos (incluidos componentes de kits) al almacén
  del que salieron. Ocultar solo quita la venta de la lista de reportes.
- Totales y textos del pie usan singular/plural correcto («1 producto
  diferente», «1 ticket válido»).

### Burbujas y estilo visual
- Los indicadores de Resumen, Liquidación por turno, Descuadres, Movimientos y
  Transferencias usan la misma burbuja visual (icono, tono, valor y pista), sin
  romper la línea visual de PALMYRA.

### Descuadres
- Los descuadres vuelven a mostrarse como lista compacta y rápida: trabajador,
  turno, fecha, faltante/sobrante, deducción y estado de auditoría en una sola
  fila que se apila en móvil.
- Los totales de faltante, sobrante y deducción se calculan una sola vez por
  filtro para que la sección responda igual de rápido en móvil y PC.

### Bancos
- Descripción y referencia se simplificaron: una sola columna «Detalle» con la
  referencia debajo en tono secundario; en móvil, cada movimiento es una fila
  apilada sin columnas recortadas.
- Nueva sección «Ingresos por turno»: agrupa los cobros recibidos por turno de
  caja con trabajador, sucursal, fecha, cantidad de cobros y el total por
  moneda, respetando el filtro de cuenta activo.

### Legibilidad y vistas
- Piso tipográfico global: ninguna etiqueta de 5–10 px queda por debajo de
  11–12 px, tanto en clases utilitarias como en estilos en línea y en Equipo.
- Nombres de trabajadores y sucursales ya no se parten en dos líneas: se
  recortan con puntos suspensivos y el texto completo queda en el tooltip.
- Las pestañas de Reportes se reparten en tres columnas en móvil (sin cortes de
  letras) y vuelven a fila desplazable en tablet y escritorio.
- Las tablas de Ventas por turno y Todos los tickets se convierten en tarjetas
  apiladas en móvil; la tabla completa solo aparece desde pantalla mediana.

## 1.0.17 — Escuela PALMYRA, cierre desde Reportes y burbujas compactas

### Escuela PALMYRA (Tutorial)
- La sección Tutorial se convirtió en una escuela completa: 18 lecciones y 94
  pasos guiados que cubren inicio, dashboard, apertura de turno, venta en POS,
  cierre, inventario, transferencias, auditoría, clientes, proveedores,
  cotizaciones, devoluciones, bancos, reportes, equipo, modo offline,
  configuración y plan.
- Cada lección incluye pantalla ilustrada con zonas numeradas, mapa del proceso
  con conectores, pasos en orden, botón «Ver punto N» que resalta la zona,
  errores comunes, resultado esperado y enlaces a lecciones relacionadas.
- Rutas por rol (Vender hoy, Controlar inventario, Administrar el negocio),
  buscador, progreso guardado en el dispositivo, reinicio de progreso y
  enlaces directos con `?lesson=`.
- Diseño responsive verificado en escritorio, tableta y móvil, en tema claro y
  oscuro; navegación por selector de lección en pantallas pequeñas.
- El centro de ayuda ahora enlaza a Escuela PALMYRA en lugar de duplicar
  instrucciones desactualizadas.

### Cierre de turno desde Reportes
- El botón «Confirmar y cerrar turno» ya no queda bloqueado cuando el servidor
  rechaza el cierre: el turno se cierra localmente, se encola para sincronizar
  y se avisa al usuario con un mensaje claro.
- El modal se muestra sobre toda la app (portal) y los avisos distinguen entre
  cierre confirmado, descuadre registrado y cierre pendiente de sincronización.
- Las etiquetas de montos esperados se recortan en columnas angostas para no
  montarse entre sí en móvil.

### Burbujas y ayudas en pantalla
- Las burbujas de ayuda se miden antes de posicionarse, aparecen arriba o abajo
  del icono según el espacio disponible y se compactaron en móvil (texto 11px,
  ancho máximo 17.5rem, altura con scroll) para una lectura cómoda.

## 1.0.16 — Clientes 360, actualizaciones visibles y bancos más limpios

### Clientes
- Rediseño completo de la sección: indicadores de clientes registrados, con
  compras, ventas acumuladas y ticket promedio, con búsqueda por nombre,
  teléfono, correo, documento o código de cliente y filtros Todos / Con compras
  / Sin compras.
- Ficha de cliente con contacto, historial de tickets (número, fecha, almacén,
  total y productos), total comprado, compras, ticket promedio y última compra.
- Vista de tarjetas en móvil y tabla en escritorio, con acciones de ver ficha,
  editar y eliminar protegidas: un cliente con ventas registradas no puede
  borrarse y se explica el motivo.
- Registro y edición con validación de nombre, formato de correo y detección de
  teléfono o correo duplicado antes de guardar.

### Actualizaciones del sistema
- La detección de nuevas versiones revisa el manifiesto real (`version.json`),
  limpia marcas obsoletas del shell de escritorio y confirma si ya estás al día
  sin recargar la aplicación.
- Barra de progreso real durante la actualización: verificación, descarga de
  los archivos del Service Worker con conteo de archivos y megabytes recibidos,
  preparación, reinicio y porcentaje visible. Los datos locales (IndexedDB y
  localStorage) nunca se borran; solo se refresca el shell.
- Errores de actualización mostrados dentro del aviso, con opción de reintentar
  sin sacar al usuario del POS.

### Bancos
- Se retiró el botón «Depurar duplicados locales»: la deduplicación ya es
  automática, por lo que no debe existir una acción manual en la interfaz.

## 1.0.15 — Cotizador, devoluciones y auditoría

### Cotizaciones
- Nuevo cotizador integrado que funciona como el Punto de Venta sin abrir turno:
  se elige el almacén, se buscan y agregan productos con stock disponible, se
  ajustan cantidades y precios, y se selecciona o crea el cliente en el momento.
- La cotización se genera como documento A4 listo para imprimir o guardar como
  PDF: encabezado con logo y datos del negocio, cliente, almacén, moneda,
  validez, detalle por producto con SKU, totales, notas y firmas.
- Listado con indicadores de pendientes, valor pendiente, convertidas y
  vencidas, búsqueda por número o cliente, duplicado y envío al TPV.

### Devoluciones y garantías
- Registro de devolución por ticket: se busca la venta, se marcan uno o varios
  artículos con cantidad limitada a lo aún devolvible y se define tipo y motivo
  en un solo paso.
- Acciones de recepción claras (Recibir, Rechazar, Cambiar tipo) y captura del
  reembolso con monto, moneda y método, con estados Pendiente, Aprobado y
  Pagado.
- Pestaña de garantías con cobertura, días restantes, barra de avance y estado
  (Vigente, Cambiada, Reclamada, Expirada); devolución directa desde la garantía.
- Códigos de devolución y garantía estables y sin colisiones, filtros por estado
  y una guía de 3 pasos para el flujo diario.

### Auditoría de stock
- Historial completo con búsqueda por sucursal, producto o nota, filtros por
  estado, avance del conteo, variaciones y valor de diferencia a costo.
- Conteo con progreso real, "Solo pendientes", "Completar con esperado", modo
  ciego y edición directa de cantidades sin marcar líneas vacías como contadas.
- Revisión con faltante/sobrante, exactitud, líneas con variación y valor,
  filtro de solo diferencias, aviso si el stock cambió después del envío y
  bloqueo de aprobación hasta resolver el recuento.
- Informe de control interno imprimible en A4 con resumen, diferencias, notas y
  firmas de auditor y supervisor.
- Corregida la exactitud histórica: las líneas sin contar ya no inflan el
  porcentaje ni el avance del conteo.

## 1.0.14 — Plan y Bancos

### Planes
- El plan Gratis ahora incluye respaldo comercial en la nube como el resto de
  los planes: los datos se sincronizan normalmente y la salud de sincronización
  ya no muestra avisos de modo local.
- Se elimina la restricción de transporte que bloqueaba las escrituras del plan
  Gratis; todos los planes comparten la misma cola offline y la misma nube.
- Rediseño de la sección Plan: panel de resumen con plan actual, estado y
  límites, tarjetas por plan con icono propio (Sprout, Palmtree, Truck, Crown) y
  paleta coherente con la marca, y un icono distinto para cada característica.
- Renovación con plan activo: la solicitud del mismo plan muestra el nuevo
  vencimiento resultante antes de enviarla y el botón principal pasa a
  "Extender plan" / "Solicitar extensión".
- Estado de solicitud pendiente con acceso directo a WhatsApp y formulario
  bloqueado mientras exista una solicitud en revisión.

### Bancos
- Saldos separados por moneda: MN, USD y MLC, cada uno con su propia tarjeta de
  resumen; "Saldo total en MN" suma todas las cuentas en moneda nacional.
- Al tocar una tarjeta se muestran sus movimientos filtrados (antes abría el
  menú de edición); la edición sigue disponible en su botón y en el menú «···».
- Nuevos tipos de tarjeta: MN, MLC y Clásica USD. Se eliminan Débito/Crédito y
  "Clásica CUP". Elegir Clásica USD ajusta la moneda a USD y elegir MLC la
  ajusta a MLC.
- Las tarjetas antiguas se normalizan al mostrarse y editarse, sin modificar los
  datos guardados.
- Tabla de movimientos con columnas legibles y desplazamiento horizontal en
  pantallas estrechas.

## 1.0.13 — Reportes y descuadres rediseñados

### Descuadres
- Reporte de descuadre moderno y en lenguaje claro: tarjetas de faltante,
  sobrante y diferencia neta, resumen de lo que pasó en el turno (ventas,
  ingresos, egresos y anuladas), tickets y movimientos del turno.
- Comparación esperado contra declarado por moneda y método, con barra de
  avance y montos en la moneda correcta.
- Nueva acción "Cuadrar la caja": documenta la causa, permite descontar el
  faltante del salario y guarda una nota firmada con fecha y autor. La
  diferencia, el arqueo y las ventas originales se conservan como evidencia.
- Eliminados los atajos "Registrar venta omitida" y "Eliminar venta duplicada"
  que alteraban ventas e inventario desde reportes.
- Los turnos con diferencia aparecen como pendientes, auditados o conciliados.
- Se excluyen ventas anuladas y ajustes internos del cálculo del arqueo.

### Cierre de turno
- El cierre desde Reportes compara en vivo lo declarado contra lo esperado por
  moneda y método (efectivo y transferencia), avisa los faltantes y sobrantes,
  y registra el descuadre al cerrar para conciliarlo después.

### Movimientos y nómina
- Los egresos y gastos se pueden corregir desde el detalle del movimiento; el
  descuadre del turno se recalcula automáticamente y queda la nota de auditoría.
- Nómina muestra la deducción por descuadre por turno y por trabajador, además
  del total neto y el acumulado de deducciones.

### Ventas, ocultamiento y exportación
- Ocultar un ticket sigue siendo solo visual: la venta, el cobro y el inventario
  no se modifican, y el reporte lo explica con un aviso.
- La exportación a Excel respeta los filtros activos y no incluye tickets
  ocultos.
- Correcciones de contraste y tipografía en reportes; acciones destructivas en
  rojo y acentos de marca en violeta.

## 1.0.12 — Proveedores y compras rediseñados

### Proveedores
- Directorio en tarjetas adaptables (móvil, tablet y escritorio) con avatar de
  iniciales, tipo de mercancía, teléfono marcable, dirección y burbujas de
  productos y órdenes en singular o plural correcto.
- Ficha de proveedor con resumen de contacto, órdenes registradas y lista de
  mercancía con precios de compra.
- Burbujas de resumen compactas (proveedores, órdenes, inversión y almacenes)
  que no se cortan en pantallas estrechas.
- Eliminación con diálogo propio y bloqueada si el proveedor tiene órdenes.

### Compras y buscador de productos
- Buscador de productos por nombre, SKU o código de barras al asociar mercancía
  a un proveedor y al agregar líneas a una orden; elimina la selección manual
  en listas largas y evita retrasos.
- Órdenes en tarjetas con estado (Borrador, Pendiente, Recibida, Cancelada),
  fecha de entrega, total con transporte y acceso a la ficha completa.
- Producto repetido y línea duplicada bloqueados; la inversión ya no suma
  órdenes canceladas.
- Confirmación de recepción idempotente y compatible con la cola sin conexión:
  el inventario solo se actualiza al confirmar la recepción.

### Visual
- Estilo Palmyra en toda la sección: degradados violeta, tarjetas redondeadas,
  pestañas segmentadas, chips de estado y rojo semántico para lo destructivo.

## 1.0.11 — Módulo de bancos rediseñado

### Tarjetas y cuentas
- Tarjetas con proporción real ID-1 (85,6 × 53,98 mm), banda magnética, chip
  dorado, sin contacto y número enmascarado por banco (BPA, BANDEC, BANMET).
- EnZona se representa como monedero (sin plástico): muestra saldo, teléfono y
  su condición de pasarela XETID. Los diseños son referenciales y se indica en
  pantalla; no reproducen el plástico oficial.
- Tipo de tarjeta visible en la cara (Débito, Crédito, Clásica, MLC, USD,
  Tropical) y saldo con el nombre de la cuenta para distinguir varias cuentas.

### Acciones y organización
- Tocar la tarjeta abre una hoja de acciones: transferir, ver movimientos,
  editar, copiar número, congelar/reactivar y eliminar con confirmación.
- Botones visibles de transferir, movimientos, editar y eliminar en cada
  tarjeta; la cuenta congelada queda atenuada sin ocultar su saldo.
- Sección a todo el ancho, rejilla adaptable y burbujas de resumen legibles en
  modo claro y oscuro. Salidas y acciones destructivas usan rojo semántico.

## 1.0.10 — Planes para Cuba, reportes rediseñados y reversión exacta

### Planes y renovación
- Cuatro planes definitivos: Gratis (permanente y restringido), Oasis,
  Caravana y Ciudadela. Se eliminó la prueba de tres meses.
- El plan Gratis funciona solo con almacenamiento local en el dispositivo: sin
  respaldo en la nube, sin sincronización de negocio y con 1 almacén y 1
  empleado. La pantalla de suscripción permite renovar o adelantar varios meses.
- Pagos aceptados: efectivo en CUP, transferencia bancaria en CUP y efectivo en
  USD, siempre con confirmación manual.

### Reportes
- Nueva jerarquía con pestañas (Resumen, Ventas, Nómina, Cajas, Descuadres) y
  KPIs de ventas cobradas, ticket promedio, unidades y ganancia bruta.
- Anulación de ventas exacta: el stock se restaura una sola vez aunque se repita
  la acción, con reversión bancaria determinista y control de devoluciones.

### Operación
- Bancos, proveedores, equipo y configuración reorganizados; Notificaciones vive
  dentro de Configuración sin exponer los ajustes de administrador a empleados.
- Sección LAN marcada como «Vista previa»: cada dispositivo conserva sus datos
  locales y la sincronización compartida por LAN aún no está activa.
- Auditoría de arquitectura y pruebas de integridad en verde (151 pruebas).

## 1.0.9 — Reportes más limpios y tasas de cambio siempre disponibles

### Reportes
- Se eliminó la fila de accesos rápidos del Resumen que repetía los contadores
  de las pestañas (Cajas, Descuadres, Nómina y Transferencias).
- El menú de exportación a Excel ahora es más compacto: reporte completo en una
  fila y las secciones en una rejilla de dos columnas, sin etiquetas largas.
- Se aumentó el tamaño de las etiquetas y cifras del resumen global y del
  desglose por divisas para mejorar la legibilidad.

### Transferencias
- Se retiró el botón duplicado «Nuevo Traslado»; queda un único acceso en la
  barra Historial / Nuevo Traslado.

### Tasas de cambio
- Solo se muestran tasas reales publicadas por elTOQUE; no se sustituyen por
  otras fuentes ni por conversiones calculadas.
- Si falta `ELTOQUE_API_TOKEN` en el servidor, la API responde con un error
  explícito y la pantalla explica que la credencial no está configurada, en
  lugar de mostrar valores inventados.
- La pantalla indica la fuente, el tipo de mercado (informal) y la fecha de los
  datos; el token sigue viviendo solo en el servidor.

## 1.0.8 — Nuevo dashboard con portada de marca

### Portada del dashboard
- Banner principal con arte de marca (camello Palmyra, terminal POS, lector y
  comerciante) sobre ola morada; el texto se dibuja en HTML para que siempre
  se lea nítido y se adapte a cada idioma y tamaño de pantalla.
- Saludo personalizado, nombre del negocio, sucursal activa, moneda base y
  sello «Offline listo» integrados en la portada.
- Encuadre de la imagen por puntos de ruptura (escritorio, tableta y móvil)
  sin deformar el arte.

### Tarjetas y accesos
- KPIs rediseñados con barra de acento, icono tintado y dato secundario:
  ventas de hoy, tickets emitidos, stock bajo y clientes.
- Nuevo bloque «Funcionalidades generales» con accesos directos a Nueva venta,
  Inventario, Reportes, Traslados, Clientes y Equipo; cada tile se oculta si el
  usuario no tiene permiso.
- Tarjeta de filosofía de marca con el emblema y el sello «Modo offline
  garantizado».

## 1.0.7 — Descargas, secciones reorganizadas y traslados en dos fases

### Landing y descargas
- Nueva sección «Descargas» con tarjetas para instalar en PC (instalador
  NSIS) y en móvil (PWA), detección de plataforma, instrucciones para iOS y
  Android, y botón de instalación directa cuando el navegador lo permite.
- Enlace «Descargas» en la navegación y botón secundario en el cierre.

### Secciones reorganizadas
- Reportes abre en «Resumen» con KPIs globales, gráficas y accesos directos a
  Cajas abiertas, Descuadres, Nómina pendiente y Transferencias; los filtros
  globales solo se muestran donde aplican.
- El filtro de trabajador ahora sí filtra Nómina, Descuadres y Movimientos.
- El botón de exportación Excel se rehabilita al cambiar de plan sin recargar.
- Pestaña de Reportes con el morado de marca en lugar de rojo.
- Botones de cerrar/cancelar muertos corregidos en «Añadir artículo al turno».

### Equipo y notificaciones
- Crear un trabajador ya no deja el formulario abierto (evitaba duplicados).
- Se rechazan correos inválidos antes de invitar.
- Los cupos del plan cuentan invitaciones pendientes; el indicador muestra
  activos reales en lugar de un contador desactualizado.
- Notificaciones: los avisos de empresa (sin usuario) se pueden marcar como
  leídos; las nuevas llegan en vivo por Realtime; el estado de push en
  escritorio explica que Electron no soporta el servicio del navegador.

### Trabajo sin conexión
- La credencial de alta sobrevive una recarga dentro de la pestaña
  (sessionStorage, 2 h) y nunca se escribe en localStorage.
- Un cierre de sesión transitorio sin internet conserva la sesión local
  verificada en lugar de expulsar al usuario.
- El arranque entra directo a la interfaz cacheada mientras valida la
  identidad en segundo plano.

### Transferencias en dos fases y ledger único
- Despacho y recepción reales: al enviar, el stock sale del origen y queda «en
  tránsito»; el almacén de destino confirma la recepción para sumarlo.
- Panel «Mercancía en tránsito» con acciones Recibir y Cancelar (la
  cancelación devuelve la mercancía al origen).
- Nuevas RPC `palmyra_dispatch_transfer`, `palmyra_receive_transfer` y
  `palmyra_cancel_transfer`, idempotentes y con control de acceso por almacén.
- Estados nuevos del traslado (`in_transit`, `received`), `batch_id`,
  `received_at` y `received_by`; historial con estados correctos.
- Índice único parcial en `stock_movements` para referencias de traslado: un
  reintento no puede duplicar el ledger. La migración aborta si detecta
  duplicados históricos en lugar de borrar datos.
- Recepción y cancelación se encolan sin conexión y se sincronizan al volver
  la red, protegiendo el stock local mientras están pendientes.

## 1.0.6 — Iconos, navegación y escritorio

- La app de escritorio ya no muestra la tarjeta «Instala PALMYRA»: el aviso de
  instalación PWA se oculta cuando la ventana corre dentro de Electron.
- El elemento activo del menú lateral usa el morado de marca (#6535C5) en lugar
  del rojo; el hover de los iconos también es morado.
- Iconos diferenciados: Bancos usa `Landmark` y Plan usa `Sparkles` (antes ambos
  compartían la tarjeta de crédito con el botón de pago).
- La landing usa iconos coherentes con el menú del POS: Proveedores `Truck` y
  Transferencias `ArrowLeftRight`; imports de iconos sin uso eliminados.
- Menú lateral más compacto: las 18 secciones caben con menos desplazamiento en
  pantallas de portátil.
- La tarjeta del plan en el pie del menú abre la pantalla de planes al pulsarla;
  el aviso de periodo vencido usa el morado de marca (antes indigo).
- Eliminado el `<link rel=preload>` de la fuente: el recurso se registraba como
  «preloaded but not used» en el log del escritorio. La fuente sigue siendo local.

## 1.0.5 — Landing offline y correcciones de operación

- La foto de la sección histórica de la landing se sirve localmente
  (`/landing/palmyra-ruins.webp`, 110 KB) y entra en el precache: la landing
  ya no depende de Wikimedia y se ve completa sin internet.
- Capturas de landing sin uso movidas a `_unused/` (el texto ahora describe
  vistas previas, no capturas inexistentes).
- Eliminado el último recurso externo de tipografía: el panel de administración
  usa Plus Jakarta Sans auto-hospedada en lugar de Google Fonts.
- Eliminados `react-qr-code`, `qrcode`, `@types/qrcode`, `favicon.svg` y las
  hojas `security.css`/`landing.css`, todos sin uso.
- Los errores al guardar un cliente ahora se muestran en el formulario
  (antes se registraban en un estado invisible).
- Las alertas de reposición respetan la sucursal activa al calcular el stock.
- Cerrar sesión avisa si hay operaciones offline pendientes y confirma antes
  de salir; la cola queda guardada para la próxima entrada con la misma cuenta.
- `npm start` detecta `dist/` y sirve el cliente compilado en lugar de arrancar
  Vite en modo desarrollo cuando `NODE_ENV` no está definido.
- Eliminados el estado y la prop muertos de Layout/CheckoutModal.

## 1.0.4 — App de escritorio y marca

- Corregida la pantalla morada del POS instalado: el servidor de escritorio se
  carga en el mismo proceso (sin proceso hijo ni `node_modules`), la ventana
  muestra una pantalla de carga y un error legible, y todo queda en
  `%APPDATA%/palmyra/desktop.log`.
- La app de escritorio ya no registra Service Workers: un worker viejo en
  `127.0.0.1:10000` servía el shell de desarrollo y dejaba la ventana vacía.
  Al arrancar se limpian solo los caches del shell (los datos locales se conservan).
- Service Worker de desarrollo desactivado: compartía origen con el POS instalado.
- Instalador NSIS por usuario, sin UAC ni páginas de opciones; las actualizaciones
  se aplican en silencio con `/S`.
- Iconos regenerados desde el símbolo oficial: `favicon.ico` real (16–256),
  PNG any/maskable, Apple Touch e icono del instalador.
- Plus Jakarta Sans auto-hospedada: el POS conserva su tipografía sin internet.
- Landing renovada; eliminados restos visuales de MARÉ.
- Menú lateral: Cotizaciones y Soporte vuelven a mostrarse y las secciones ya
  apuntan a rutas existentes.
- Icono de notificaciones push corregido (`pwa-192.png`).
- Código y assets sin uso movidos a `_unused/` (fuera del build).

## Estabilización integral

- Corregido el doble descuento de inventario en ventas online.
- Ventas online confirmadas por RPC antes de actualizar el espejo local.
- Ventas offline conservan el mismo ID para reintentos idempotentes.
- Eliminado el fallback de venta que hacía `upsert` directo y podía omitir el movimiento de stock.
- Kits soportan consumo real de componentes en servidor.
- Anulación de venta usa RPC y revierte los movimientos originales, incluidos componentes de kits.
- Devoluciones validan acumulado contra lo realmente vendido.
- Garantías ya no descuentan incorrectamente el producto devuelto; un reemplazo se descuenta explícitamente cuando existe.
- Transferencias usan operación idempotente y transacción server-side.
- Recepción de proveedores solo aplica stock en transición `PENDING → RECEIVED`.
- Auditorías de inventario solo se completan una vez y el servidor calcula `actual - esperado`.
- Apertura de caja protegida contra dos turnos abiertos en la misma sucursal.
- Cierre de caja evita liquidaciones de salario duplicadas.
- Inventario normaliza variantes y consolida duplicados lógicos conservando la suma de cantidades.
- Añadido historial `inventory_movements`.
- Añadida columna persistente `products.kit_components`.
- Eliminada la sustitución silenciosa de sucursales/categorías/IDs inválidos en `safeUpsert`.
- Eliminado el borrado físico de transacciones desde `deleteTransactionFromSupabase`.
- Eliminado el límite de 500 registros para transacciones, bancos y turnos mediante paginación.
- Sincronización de transacciones/cajas/devoluciones deja de resucitar registros locales que no están en Supabase salvo operaciones pendientes reales.
- La caché del dispositivo ya no borra la cola offline ni el respaldo local de ventas al ejecutar un hard reset.
- Los pagos bancarios de una venta se registran después de confirmar la venta.
- Añadidas vistas de diagnóstico de sucursales duplicadas y uso por sucursal.

## Validación

- Los 37 archivos TypeScript/TSX fueron analizados por parser de TypeScript sin errores de sintaxis.
- `scripts/integrity-smoke.mjs` pasa todas las invariantes críticas.
- La compilación completa no pudo ejecutarse en este entorno porque las dependencias del proyecto no están instaladas y el entorno no tiene acceso al registro npm. El código sí fue sometido a comprobación sintáctica independiente.

## Restauración offline-first — 2026-09-26
- Persistencia principal migrada a IndexedDB con escrituras agrupadas.
- Cola offline serializada y protegida contra sobrescrituras concurrentes.
- Bootstrap POS ligero por sucursal.
- Realtime reducido a inventario/transacciones y actualización directa del caché de inventario.
- Ajustes de inventario convertidos a operaciones idempotentes.
- Reconciliación de inventario protegida contra cambios remotos.
- RPC de ventas agregada por SKU/variante y locks deterministas.
- Bulk "Guardar Datos Maestros" dejó de sobrescribir stock y ventas.
- Recuperación de ventas desde backup usa RPC idempotente.
- POS usa selectores shallow para reducir renders globales.
