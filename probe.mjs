// Hardware probe: what does this body have?
import sdl from '@kmamal/sdl'

console.log('SDL version:', sdl.info.version.compiled)

console.log('\n--- Joysticks/Gamepads ---')
console.log('joystick devices:', JSON.stringify(sdl.joystick.devices, null, 2))
console.log('controller devices:', JSON.stringify(sdl.controller.devices, null, 2))

console.log('\n--- Audio ---')
console.log('playback devices:', JSON.stringify(sdl.audio.devices.filter(d => d.type === 'playback'), null, 2))
console.log('recording devices:', JSON.stringify(sdl.audio.devices.filter(d => d.type === 'recording'), null, 2))

console.log('\n--- Video ---')
console.log('displays:', sdl.video.displays.map(d => `${d.name} ${d.geometry.w}x${d.geometry.h}`))

// Try opening a small window for 3 seconds
const win = sdl.video.createWindow({ title: 'corp probe', width: 240, height: 240 })
const { pixelWidth: w, pixelHeight: h } = win
const buf = Buffer.alloc(w * h * 4)
for (let i = 0; i < w * h; i++) buf.writeUInt32LE(0xff224422, i * 4) // dark green
win.render(w, h, w * 4, 'bgra32', buf)
console.log('\nwindow opened OK:', w, 'x', h)
setTimeout(() => { win.destroy(); console.log('window closed OK'); process.exit(0) }, 3000)
