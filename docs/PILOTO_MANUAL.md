# Manual de campo del piloto PALMYRA

Guía para el dueño del negocio y el personal del piloto. No hace falta saber
informática: cada paso indica qué tocar dentro de la app. Versión del piloto:
**1.3.5**. Este manual no contiene contraseñas, frases de respaldo ni claves de
recuperación, y ninguna de esas claves debe copiarse aquí.

En la app puedes abrir **Tutorial** para las lecciones guiadas y **Soporte** para
pedir ayuda. **Configuración → Sistema → Piloto** reúne la **Lista del piloto** y
las **Métricas del piloto**; la lista marca estos mismos pasos y guarda el avance
en el equipo. La **Migración guiada al almacén local** está en
**Configuración → Sistema → Administración avanzada**.

## Antes de empezar

Reúne esto antes de instalar:

- **PC principal (hub)**: Windows 10 u 11 de 64 bits, 4 GB de memoria o más,
  2 GB libres en disco, conectada a la corriente (mejor con respaldo/UPS) y
  encendida durante toda la jornada. Este equipo guarda y reparte los datos del
  negocio a las demás cajas. No lo apagues ni lo suspendas.
- **Equipos adicionales**: PC con Windows o teléfono/tablet Android 7.0 o
  superior (el APK exige Android 7+). Todos en el mismo Wi-Fi del negocio.
- **Wi-Fi del negocio**: red estable con su clave. Los equipos no deben usar
  datos móviles para hablar con el hub. Anota la dirección IP del PC principal;
  si el router la cambia, hay que volver a emparejar.
- **Cuenta web**: un correo al que tengas acceso (revisa también Spam), la
  cuenta confirmada y la empresa con su almacén creados. El dueño debe ser
  administrador.
- **Plan activo**: Gratis, Oasis, Caravana o Ciudadela. Para varias cajas,
  respaldo en la nube y funciones de control, el piloto usa **Caravana**.
- **Un pendrive o disco USB** para guardar respaldos y actualizaciones.
- **Una libreta** para anotar métricas y el número de versión instalada.

Antes de vender de verdad, haz un ensayo: crea un respaldo, restáuralo en un
equipo de prueba y empareja una caja. Si algo falla, es mejor descubrirlo con el
negocio cerrado.

## Instalar en PC

1. Descarga el instalador de Windows (`PALMYRA-POS-Setup-….exe`) desde la página
   oficial de descargas o desde **GitHub Releases** del repositorio
   `Cristian0311/palmyra` (sección *Releases*, archivo *Setup* de Windows).
2. **Aviso de SmartScreen**: es normal que Windows muestre «Windows protegió tu
   PC» porque el instalador no tiene certificado comercial. Pulsa **Más
   información** y luego **Ejecutar de todas formas**. Si el aviso aparece con
   un nombre de editor distinto o descargaste el archivo por WhatsApp/Telegram,
   no lo instales: bórralo y vuelve a bajarlo de la página oficial.
3. Sigue el asistente: carpeta de instalación, **Instalar** y **Finalizar**.
   Se crea el acceso directo **PALMYRA POS**.
4. Abre PALMYRA POS. Inicia sesión con la cuenta web y elige la empresa. La
   primera carga trae el catálogo y la operación reciente; deja que termine.
5. Comprueba la instalación en **Configuración → Administración avanzada →
   Diagnóstico de instalación**: debe mostrar la versión 1.3.5, el servidor
   local respondiendo y sin errores en rojo. El botón **Reparar instalación**
   solo se usa si la pantalla queda en blanco; no borra ventas ni inventario.
6. Activa el hub: **Configuración → Red local → Permitir acceso LAN**. Si la app
   pide reiniciar («Cierra y vuelve a abrir PALMYRA POS»), ciérrala y ábrela. La
   tarjeta **Red local** debe decir **Activo** y mostrar la dirección.
7. Revisa **Configuración → Administración avanzada → Actualizaciones firmadas**
   para confirmar que la app puede buscar actualizaciones.

## Instalar en Android

1. Descarga el APK (`PALMYRA-….apk`) desde la misma página oficial de descargas o
   desde **GitHub Releases** (`Cristian0311/palmyra`). No instales APK reenviados
   por mensajería.
2. Al abrirlo, Android pedirá **permitir instalar aplicaciones desconocidas**
   para Chrome o para el explorador de archivos. Actívalo para esa app y vuelve
   atrás. Si Play Protect avisa, elige **Instalar de todas formas**: el APK no
   viene de Play Store.
3. Abre PALMYRA, inicia sesión y elige la empresa. El teléfono guarda su propia
   copia local; las ventas se comparten con el hub cuando está emparejado.
4. **Actualización normal (OTA)**: la app consulta el manifiesto firmado y
   ofrece instalar. Si dice «Este instalador no permite actualizar desde la
   app», descarga el APK más reciente e instálalo encima; los datos se
   conservan.
5. **Actualizar por USB/SD**: copia el APK o el paquete `.zip` al teléfono y ve
   a **Configuración → Administración avanzada → Actualizar desde archivo
   (USB/SD) → Instalar APK**. Solo se aplican versiones más nuevas y con firma
   válida.
6. **Respaldo automático en Android**: en **Configuración → Administración
   avanzada → Respaldo automático** verás la última copia, la próxima y la
   ubicación (Descargas). Pulsa **Copiar clave** y guárdala fuera del teléfono.
   Se conservan los 7 respaldos más recientes.

## Emparejar equipos por QR y manual

El PC principal es el **hub**. Las demás cajas se **vinculan** a él.

1. En el PC principal: **Configuración → Red local** y confirma que el
   interruptor **Permitir acceso LAN** está activo y la tarjeta dice **Activo**.
2. Pulsa **Generar código nuevo**. Aparece un **código de 8 dígitos** (caduca en
   minutos; cada código nuevo invalida el anterior) y un **QR** con el texto
   «Escanea desde el otro equipo».
3. Si el hub escucha en todas las interfaces, escribe en **IP de este equipo en
   la red** la IP del PC principal para que el QR apunte a ella.
4. En la otra caja: abre PALMYRA (por la dirección local o desde la app
   instalada) y ve a **Configuración → Red local → Vincular otro equipo**.
   - **Por QR**: pega el contenido leído en **Contenido del QR (o URL del hub)**.
     Se rellenan la dirección y el código.
   - **Manual**: escribe la **Dirección del hub** (por ejemplo
     `192.168.1.10:48900`) y el **Código de 8 dígitos**. Si el hub lo exige,
     escribe también el **PIN de este equipo (4-8 dígitos, opcional)**.
5. Pulsa **Vincular**. Debe aparecer **Vinculado** con el hub, el equipo y la
   dirección. Repite en cada caja, una por una.
6. En **Máquinas conectadas** renombra cada equipo por su caja o área y **olvida**
   las que ya no se usan. Para retirar una caja usa **Desvincular**.

**Si la búsqueda automática no encuentra el hub** («No se encontró ningún hub»),
escribe la IP manualmente: muchos routers bloquean el descubrimiento mDNS. Que
el PC principal y la caja estén en la misma red, con el firewall de Windows
permitiendo PALMYRA. Nunca uses `localhost` en otra caja: apunta a sí misma.

Comparte el código solo con el equipo que estás vinculando. No reutilices el QR
de otro negocio ni el de una caja que ya no está en la red.

## Vender sin internet

PALMYRA sigue vendiendo cuando se cae internet o el Wi-Fi:

- La venta, el movimiento o el cierre se guardan en una **cola durable** del
  equipo. Si cierras o recargas la app, la operación no desaparece.
- **Límites**: sin internet no se sincroniza con la nube, no se piden datos
  nuevos ni se cambian planes; las tasas y el catálogo usan la última copia
  válida. El piloto admite hasta 5 equipos por hub.
- **Cola y conflictos**: revisa **Configuración → Conexión y datos → Salud
  offline** (pendientes, conflictos, último sync). **Sincronizar ahora** fuerza
  el envío cuando vuelve la conexión.
- Un **conflicto** aparece cuando dos equipos modificaron lo mismo. Se muestra en
  **Salud offline → Conflictos** y no se pisa nada solo: hay que decidir. No lo
  ignores, porque esa operación no se consolida.
- **72 horas sin hub**: la caja puede seguir vendiendo mientras el hub esté
  caído. Si pasan 72 horas sin contacto con el hub, el equipo pasa a **solo
  lectura** (se consulta y se exporta, no se escribe) y el botón de exportación
  de solo lectura está en **Configuración → Red local**. Al volver el hub, se
  reanuda la escritura.
- **Nunca borres los datos del navegador** (ni uses modo incógnito) con
  operaciones pendientes: la cola vive en el almacenamiento de ese equipo.

## Respaldar

### Respaldo local (cifrado, sin internet)

1. Ve a **Configuración → Administración avanzada → Respaldo cifrado del
   almacén local**.
2. Escribe una **Frase de cifrado (mínimo 8 caracteres)** que solo tú conozcas.
   La frase no se guarda: si se pierde, el archivo no se puede abrir ni
   restaurar.
3. Pulsa **Crear respaldo y descargar**. Se descarga un archivo cifrado
   (AES-256-GCM) con fecha en el nombre.
4. Cópialo a un pendrive y a un segundo lugar (otro PC, teléfono o disco). Ten
   siempre **dos copias en sitios distintos**. Hazlo a diario, al cerrar caja.
5. **Verifícalo** al menos una vez por semana: en **Restaurar respaldo**, elige
   **Verificar archivo**, selecciona el archivo y escribe la frase. Debe mostrar
   la fecha, la versión y los conteos. Verificar no cambia nada.

En Android, además del respaldo manual, la tarjeta **Respaldo automático**
guarda copias cifradas en Descargas y conserva las 7 más recientes.

### Respaldo en la nube (diario)

1. En la misma pantalla, abre **Respaldo en la nube**. Necesita internet y
   sesión iniciada. La caja sigue vendiendo aunque la nube falle.
2. La app genera una **clave de recuperación por empresa** para que el respaldo
   diario funcione sin abrir Ajustes. Pulsa **Copiar clave** y guárdala fuera del
   equipo (papel en caja fuerte, gestor de contraseñas del dueño).
3. Escribe tu frase o deja que use la clave del equipo y súbelo. La subida
   automática ocurre **cada 24 horas** y se reintenta al volver la red.
4. Comprueba en **Días en la nube** que el día de hoy aparece con tamaño y
   registros, y que el pie dice cuál fue el último respaldo.

**Aviso que debes repetir en soporte**: si se pierden la frase y la clave de
recuperación, el respaldo es irrecuperable. Ni PALMYRA ni Supabase pueden
descifrarlo. Borrar los datos del navegador o cambiar de equipo sin haber
guardado la clave equivale a perderla.

## Restaurar

**Cuándo usar cada uno**

- **Local**: cambiaste o se dañó un equipo y tienes el archivo en USB. Es la vía
  más rápida y no necesita internet.
- **Nube**: perdiste el equipo, el USB no está o la copia local es más vieja.
  Necesita internet y la clave de recuperación.
- **Hub**: falló el PC principal y otro PC debe pasar a ser el hub. Primero se
  restaura en el PC nuevo y después se vuelven a emparejar las cajas.

**Antes de restaurar**: deja de vender, cierra el turno, **detén la red local
(hub LAN)** y anota el último número de ticket. La restauración reemplaza los
datos locales de ese equipo.

### Restaurar un respaldo local

1. **Configuración → Administración avanzada → Restaurar respaldo**.
2. Pulsa **Restaurar desde el dispositivo** y elige el archivo cifrado. Usa
   **Verificar archivo** y revisa la fecha y los conteos.
3. Marca **Entiendo que esta acción reemplaza los datos locales y que deberé
   reiniciar PALMYRA al terminar** y pulsa **Restaurar ahora**.
4. Reinicia PALMYRA y revisa ventas, inventario y caja del día restaurado.

### Restaurar desde la nube

1. En **Respaldo en la nube → Restaurar desde la nube**, elige el **Día del
   respaldo**.
2. Escribe la **Frase del respaldo** o pulsa **Usar la clave de este equipo**.
3. Escribe **RESTAURAR** para confirmar y pulsa **Restaurar desde la nube**. La
   app comprueba tamaño, SHA-256 y conteos antes de escribir.
4. Pulsa **Reiniciar PALMYRA ahora**. Los cambios posteriores a ese día se
   pierden en este equipo; la nube conserva su copia.

### Restaurar el hub en otro PC

1. Instala PALMYRA en el PC sustituto e inicia sesión con la cuenta del dueño.
2. Restaura el respaldo local más reciente o el de la nube, **antes** de
   emparejar cajas.
3. En el PC nuevo, **Configuración → Red local → Diagnóstico de escritorio →
   Rollback y restauración del hub** lista los respaldos `.pbak` que dejó el hub.
   Elige uno, escribe **RESTAURAR**, marca la casilla y pulsa **Restaurar el
   hub**; la app pide una confirmación final en una ventana de Windows y antes
   guarda una **instantánea de seguridad** del estado actual. Si esa copia falla,
   la restauración se cancela.
4. Activa **Permitir acceso LAN**, genera un código nuevo y vuelve a vincular
   cada caja (**Vincular de nuevo** si la dirección del hub cambió).
5. Nunca dejes dos PC como hub del mismo negocio: elige uno y apaga la red local
   en el otro.

**Meta del piloto: restaurar en menos de 15 minutos.** Para lograrlo ten el
respaldo local en USB, la clave de recuperación a mano y un ensayo hecho. Si la
restauración tarda más o falla la verificación, para y llama a soporte antes de
seguir vendiendo.

## Actualizar

- **Automático (PC)**: **Configuración → Administración avanzada →
  Actualizaciones firmadas** consulta el manifiesto firmado cada 24 horas y
  ofrece instalar. La firma la valida la app, no el aviso de Windows.
- **Manual (PC)**: en la misma tarjeta pulsa **Buscar actualización** y luego
  **Instalar actualización**. La app se reinicia al terminar.
- **PC por USB**: copia el instalador `.exe` nuevo al equipo y usa
  **Configuración → Red local → Diagnóstico de escritorio → Instalar desde
  archivo (.exe)**, o ejecuta el Setup. Instalar encima conserva los datos.
- **Android OTA**: la app avisa y aplica el paquete firmado. Si el instalador no
  admite actualización interna, instala el APK nuevo encima del anterior.
- **Android por USB/SD**: **Configuración → Administración avanzada → Actualizar
  desde archivo (USB/SD)**.

**Reglas**

- **Nunca fuerces un downgrade** desde el actualizador: solo se aceptan
  versiones más nuevas («Solo se aplican versiones más nuevas que la
  instalada»). Para volver atrás se usa el instalador anterior, no el manifiesto.
- No instales APK de origen desconocido ni actualices en plena venta: hazlo al
  cerrar caja y con un respaldo reciente.
- Guarda siempre el instalador anterior y anota su número de versión.
- **Rollback**: si la versión nueva rompe algo, instala el Setup/APK anterior
  guardado. Si sospechas daño en los datos, restaura el respaldo previo a la
  actualización. Si el problema es de pantalla en blanco, prueba **Reparar
  instalación** en **Diagnóstico de instalación** antes de tocar datos.

## Si el hub falla

Síntomas: las cajas no ven los cambios, aparece **Sin vincular**, la dirección
local no abre o el código de emparejamiento no se genera.

1. **Energía**: confirma que el PC principal está encendido, conectado a la
   corriente y que Windows no lo suspendió. Desactiva la suspensión automática.
2. **Red**: todos en el mismo Wi-Fi. Revisa que la IP del hub no cambió (fija una
   reserva DHCP en el router) y que el firewall de Windows permite PALMYRA.
3. **Reinicia la app**: cierra PALMYRA POS y vuelve a abrirla. Si había un cambio
   de red pendiente, la app lo pide («Cierra y vuelve a abrir PALMYRA POS»).
4. **Reinicia el PC** y revisa **Configuración → Red local**: debe decir
   **Activo** con la misma dirección. Si la IP cambió, genera un QR nuevo y
   vuelve a vincular las cajas.
5. **Restaura el respaldo** en el mismo PC (local) o en el PC sustituto (hub),
   siguiendo la sección **Restaurar**.
6. **Mientras el hub está caído**: cada caja sigue vendiendo hasta 72 horas; al
   pasar ese plazo queda en **solo lectura** y puedes exportar desde **Red
   local**. Si la avería es larga, designa un PC sustituto como hub con el
   respaldo más reciente y vuelve a emparejar. No operes dos hubs a la vez.
7. **Soporte**: abre **Soporte** en el menú y crea una solicitud. Adjunta la
   fecha y hora, la versión, la dirección del hub, el último sync y el número de
   operaciones pendientes. El diagnóstico de la app se añade solo. **No envíes
   contraseñas, frases de respaldo ni claves de recuperación.**

## Migrar al almacén local

Solo si la app sigue en el **modo anterior** y PALMYRA te pide migrar. La
migración no se ejecuta sola: cada paso lo confirmas tú.

1. Crea el **respaldo cifrado** (sección **Respaldar**) y tenlo guardado fuera
   del equipo. Sin un respaldo reciente la migración queda bloqueada.
2. Ve a **Configuración → Sistema → Administración avanzada → Migración guiada
   al almacén local**, paso **1. Analizar**, y pulsa **Analizar estado legado**;
   muestra cuántas filas hay y no escribe nada.
3. En el paso **2. Respaldo obligatorio**, pulsa **Crear respaldo ahora**. El
   comprobante vale **30 minutos**; pasado ese tiempo hay que crear otro.
4. En el paso **3. Migrar y verificar**, pulsa **Migrar ahora**; al terminar
   compara filas, ventas, stock y huella. Si algo no cuadra, la app no da la
   migración por buena y no consolida.
5. Si necesitas volver atrás, usa **Volver al modo anterior**: la caja sigue con
   los datos del modo anterior, el respaldo queda intacto y esos datos se
   conservan 30 días.

## Métricas del piloto y qué reportar

Anota a diario durante las cuatro semanas del piloto (vale una libreta si no
hay internet). La app ya reúne la mayoría de estos números: en
**Configuración → Sistema → Piloto → Métricas del piloto** ves la tabla de los
últimos 7 días, y los botones **Copiar** y **Descargar JSON** producen el
informe local listo para enviar. El historial se conserva 90 días en el equipo.

- **Solicitudes o ventas por día** y tickets promedio.
- **Conflictos por día** (Salud offline → Conflictos) y cuántos quedaron sin
  resolver.
- **Ventas en riesgo**: operaciones pendientes al cerrar caja y su importe.
- **Actualizaciones**: versión instalada en PC y Android, si se aplicó sola, por
  USB o falló.
- **Disponibilidad del hub**: horas caído, causa y si hubo que restaurar.
- **Respaldos**: último local, último en la nube y si la verificación y la
  restauración de prueba funcionaron.
- **Equipos**: cuántos emparejados, cuántos activos y fallos de vinculación.

Reporta cada semana al equipo de PALMYRA con los números, una nota corta de lo
que pasó y el texto del diagnóstico de **Soporte**. Si algo bloquea la venta,
repórtalo el mismo día. Además de los números reales, el equipo de PALMYRA
compara el consumo con `npm run pilot:sim` y repite el simulacro de
restauración con `npm run drill:restore` antes de cada visita.

## Contacto y canales oficiales

- **Dentro de la app**: menú **Soporte**. Crea una solicitud; la app adjunta
  empresa, versión, conexión y operaciones pendientes. Si el administrador
  publicó canales verás **Escribir por WhatsApp** o el correo de soporte. Si aún
  no hay canal configurado, la solicitud se registra igual y puedes usar el
  correo de soporte cuando esté publicado. No inventes números ni direcciones.
- **Descargas y actualizaciones**: **GitHub Releases** del repositorio
  `Cristian0311/palmyra` (`github.com/Cristian0311/palmyra/releases`). Es el
  único canal oficial para el Setup de Windows y el APK.
- **Soporte urgente**: marca la solicitud como hub caído o pérdida de datos e
  incluye el diagnóstico. Los tiempos de respuesta son los acordados para el
  piloto.
- **Nunca compartas** contraseñas, frases de respaldo, claves de recuperación ni
  el código de emparejamiento con personas ajenas al negocio.
