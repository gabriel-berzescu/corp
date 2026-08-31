/**
 * SDL reads hints from the environment when it loads. Without this one the
 * controller goes numb whenever the face window loses focus — Windows SDL
 * drops joystick events for unfocused apps by default. Must run before
 * @kmamal/sdl is imported anywhere, so this module is imported first.
 */
process.env.SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS = '1';

export {};
