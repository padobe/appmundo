# Planeta en vivo

Un globo terráqueo 3D con lo que está pasando en el mundo **ahora mismo**:

- **Día y noche en tiempo real**: la posición del sol se calcula a partir de la hora UTC y un shader mezcla la Tierra de día con las luces nocturnas de las ciudades, con un terminador suave, reflejo del sol en los océanos, halo atmosférico y bloom (en escritorio).
- **Zoom hasta el suelo**: al acercarte (rueda, pellizco o doble clic) el globo carga imágenes de satélite de alta resolución por teselas, hasta ~1,6 km de altitud, con nombres de lugares opcionales.
- **Nubes reales**: composición global de satélites meteorológicos que se renueva cada 3 h.
- **Terremotos de las últimas 24 h**: ondas animadas con tamaño y color según su magnitud. Se actualizan cada 5 minutos.
- **Estación Espacial Internacional en directo**: posición interpolada, estela de 30 minutos, zona desde la que es visible y botón para seguirla.
- **Aviones en vuelo**: unos 10 000 aviones (OpenSky), con su avance estimado entre actualizaciones.
- **Repetición de 24 h**: la línea de tiempo reproduce el último día: el terminador se desplaza y los terremotos aparecen con una onda en el momento en que ocurrieron.

Es una web estática, sin paso de build ni backend: `index.html` + JS/CSS planos, con three.js cargado desde CDN mediante un *import map*.

## Verla en local

Hace falta un servidor HTTP (los módulos ES no funcionan abriendo el archivo con `file://`):

```sh
npx serve .
```

y abre la dirección que indique (por defecto http://localhost:3000). Para tener aviones recientes en local:

```sh
node scripts/fetch-planes.mjs
```

## Publicación (GitHub Pages)

La Action `.github/workflows/pages.yml` publica la web en cada push a `main` y, además, cada 15 minutos descarga los aviones de OpenSky a `data/planes.json` y vuelve a publicar. OpenSky no permite llamadas desde navegadores de otros dominios, por eso se hace ahí. En *Settings → Pages* hay que elegir **Source: GitHub Actions**.

Opcional: con una cuenta gratuita de OpenSky, crea un cliente de API y guarda `OPENSKY_CLIENT_ID` y `OPENSKY_CLIENT_SECRET` como *secrets* del repositorio; da más cuota y es más fiable que el acceso anónimo. GitHub pausa las Actions programadas tras 60 días sin actividad en el repo.

## Estructura

```
index.html              interfaz e import map
css/style.css           estilos
js/main.js              escena, cámara, zoom, bloom, bucle y registro de capas
js/globe.js             shader del planeta (compartido con las teselas), atmósfera y cielo
js/tiles.js             imágenes de satélite por teselas (quadtree de nivel de detalle)
js/timeline.js          reloj de la escena: directo o repetición de 24 h
js/sun.js               posición del sol
js/geo.js, regions.js   utilidades geográficas
js/layers/*.js          una capa por fuente de datos (terremotos, ISS, aviones, nubes)
scripts/fetch-planes.mjs descarga de aviones (la usa la Action)
assets/textures/        texturas de la Tierra y del cielo
```

Para añadir una fuente nueva (barcos, clima…) se crea una clase en `js/layers/` con `start()`, `update(dt)`, `pick(x, y, radio)` y `setVisible(on)`, y se registra en `js/main.js`. La hora se pide siempre a `ctx.time.now()`, así la capa funciona también en la repetición.

## Fuentes de datos y créditos

- Terremotos: [USGS Earthquake Hazards Program](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php), feed GeoJSON `all_day`.
- ISS: [Where the ISS at?](https://wheretheiss.at/w/developer) (`api.wheretheiss.at`), también usada para saber sobre qué país pasa.
- Aviones: [The OpenSky Network](https://opensky-network.org/) (uso no comercial).
- Nubes: [live-cloud-maps](https://github.com/matteason/live-cloud-maps) de Matt Eason (datos de EUMETSAT y NOAA).
- Imágenes de satélite y nombres: Esri World Imagery y World Boundaries and Places (Esri, Maxar, Earthstar Geographics y la comunidad de usuarios de GIS), con atribución.
- Texturas del globo: NASA Blue Marble y Earth at Night (Visible Earth), en las versiones que distribuye [three-globe](https://github.com/vasturiano/three-globe) (MIT).
- Render 3D: [three.js](https://threejs.org/) (MIT).
