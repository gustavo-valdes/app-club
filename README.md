# 📖 Club de Lectura — Chat

Portal de chat para lectores: crea salas nombradas con el título de un libro, chatea con emojis, protege tu sala con password, transfiere el rol de host, fusiona dos salas en una, y comparte un video de YouTube sincronizado para todos.

## Correr localmente

```bash
npm install
npm start
```

Abre `http://localhost:3000` en varias pestañas/navegadores para simular distintos usuarios chateando entre sí.

## Funcionalidades

- **Salón General**: siempre abierto, sin host, para que todos charlen de cualquier libro.
- **Crear salas por libro**: con título libre y password opcional.
- **Passwords**: si una sala tiene password, solo entra quien lo conozca.
- **Host y control de la sala**: quien crea la sala es el host. El host puede:
  - Transferir su rol a otra persona dentro de la sala.
  - Fusionar su sala con otra (por ejemplo, la sala del libro y la de su secuela) — el otro host debe aceptar la propuesta.
  - Poner, pausar y cambiar un video de YouTube para todos.
- **Si el host se desconecta (por un refresh, cerrar la pestaña, o perder conexión), la sala NO se cierra de inmediato**: entra en un periodo de gracia (5 minutos por defecto, configurable por el host hasta 120 min) durante el cual otros usuarios pueden seguir chateando y ven una cuenta regresiva. Si el host vuelve a entrar antes de que se acabe el tiempo, recupera su rol al instante. Si no vuelve a tiempo, la sala se cierra (como las salas de Battle.net de StarCraft).
- **Identidad privada por persona**: la primera vez que alguien entra, el servidor le asigna un ID privado de 50 dígitos (nunca visible para otros usuarios) y lo guarda en el navegador de esa persona. Así, aunque actualice la página o se le caiga la conexión, el servidor la reconoce como la misma persona y le devuelve su rol de host. Los nombres también son únicos: nadie más puede tomar un nombre ya usado mientras el servidor siga corriendo. Todo esto vive en memoria y se reinicia solo si el proceso del servidor se reinicia por completo (cerrar la terminal, redeploy, etc).
- **Video embebido de YouTube**: el host controla play/pause/selección para todos (los controles nativos de YouTube están deshabilitados para el resto, así nadie más puede pausar el video). El video arranca silenciado para todos (incluido el host) porque los navegadores bloquean el autoplay con sonido sin un clic reciente; cada quien puede activar su propio sonido con un botón.
- **Chat con emojis**: selector rápido de emojis integrado.
- **Estética**: paleta marrón + pastel, tipografía cálida tipo "biblioteca acogedora".

## Estructura del proyecto

```
server.js         → backend Express + Socket.io (estado de salas en memoria)
public/index.html → estructura de la app (lobby + chat)
public/style.css  → estética marrón/pastel
public/app.js     → lógica de cliente (sockets, chat, video, modales)
```

## Notas y límites conocidos

- El estado de las salas vive **en memoria** del servidor: si el servidor se reinicia, las salas se pierden (el Salón General se vuelve a crear automáticamente). Para persistencia real entre reinicios habría que sumar una base de datos.
- Las passwords se comparan con un hash SHA-256 simple: suficiente para controlar el acceso casual a una sala de lectura, no pensado como seguridad de nivel bancario.
- La sincronización del video usa el tiempo reportado por el host al pausar/reproducir; puede haber un pequeño desfase de segundos entre espectadores, normal en este tipo de sincronización simple.
