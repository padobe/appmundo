# Planeta en vivo

Un globo terráqueo 3D con lo que está pasando en el mundo **ahora mismo**:

- **Día y noche en tiempo real**: la posición del sol se calcula a partir de la hora UTC y un shader mezcla la Tierra de día con las luces nocturnas de las ciudades, con un terminador suave, reflejo del sol en los océanos y halo atmosférico.
- **Terremotos de las últimas 24 h**: cada uno es una onda animada con tamaño y color según su magnitud. Se actualiza cada 5 minutos.
- **Estación Espacial Internacional en directo**: posición interpolada para que se mueva con fluidez, estela de los últimos 30 minutos, zona desde la que es visible y botón para seguirla con la cámara.

Es una web estática, sin paso de build ni backend: `index.html` + JS/CSS planos, con three.js cargado desde CDN mediante un *import map*.

## Verla en local

Hace falta un servidor HTTP (los módulos ES no funcionan abriendo el archivo con `file://`):

```sh
npx serve .
```

y abre la dirección que indique (por defecto http://localhost:3000).

## Estructura

```
index.html            interfaz e import map
css/style.css         estilos
js/main.js            escena, cámara, controles, bucle y registro de capas
js/globe.js           shader del planeta, atmósfera y cielo
js/sun.js             posición del sol
js/geo.js, regions.js utilidades geográficas
js/layers/*.js        una capa por fuente de datos (terremotos, ISS…)
assets/textures/      texturas de la Tierra y del cielo
```

Para añadir una fuente nueva (aviones, barcos, clima…) se crea una clase en `js/layers/` con `start()`, `update(dt)` y `pick(x, y, radio)` y se registra en `js/main.js`.

## Fuentes de datos y créditos

- Terremotos: [USGS Earthquake Hazards Program](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php), feed GeoJSON `all_day`.
- ISS: [Where the ISS at?](https://wheretheiss.at/w/developer) (`api.wheretheiss.at`), también usada para saber sobre qué país pasa.
- Texturas: NASA Blue Marble y Earth at Night (Visible Earth), en las versiones que distribuye el proyecto [three-globe](https://github.com/vasturiano/three-globe) (MIT).
- Render 3D: [three.js](https://threejs.org/) (MIT).
