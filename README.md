# PiezaCerca

App para encontrar repuestos de carros en las tiendas de San Cristóbal, comparar precios y escribirles por WhatsApp.

## Cómo está organizada

- `app/` es la aplicación que se publica en internet. Son archivos que el navegador carga directo, sin pasos de compilación.
  - `index.html`: la página principal.
  - `styles.css`: colores, letras y diseño.
  - `js/config.js`: datos de conexión con Supabase (solo la clave pública).
  - `js/buscar.js`: búsqueda de repuestos y detalle.
  - `js/mapa.js`: mapa y lista de tiendas.
  - `js/app.js`: arranque de la app y navegación entre pestañas.
  - `sw.js` y `manifest.webmanifest`: permiten instalar la app en el teléfono.
- `supabase/`: la estructura de la base de datos, para ejecutar en el SQL Editor de Supabase.

## Publicar en Cloudflare Pages

- Framework preset: **None**
- Build command: *(vacío)*
- Build output directory: `app`

## Seguridad

La clave de `js/config.js` es la clave pública de Supabase y puede estar en el código.
Nunca se debe poner aquí la clave **secret** / **service_role** ni la contraseña de la base de datos.
