/**
 * Voice — the laptop speakers via Windows SAPI (System.Speech), zero-install.
 * Text goes to PowerShell over stdin, so no escaping can mangle an utterance.
 * Utterances queue; the body does not talk over itself.
 */
import { spawn } from 'node:child_process';

export class Voice {
  private queue: Promise<void> = Promise.resolve();

  /** Queue an utterance. Resolves when it has been spoken. */
  say(text: string, rate = 0, voice?: string): Promise<void> {
    const spoken = this.queue.then(() => this.speak(text, rate, voice));
    this.queue = spoken.catch(() => {});
    return spoken;
  }

  private speak(text: string, rate: number, voice?: string): Promise<void> {
    const select = voice ? `try { $sp.SelectVoice('${voice.replace(/'/g, "''")}') } catch {};` : '';
    const script =
      'Add-Type -AssemblyName System.Speech;' +
      '$sp = New-Object System.Speech.Synthesis.SpeechSynthesizer;' +
      `$sp.Rate = ${Math.max(-10, Math.min(10, Math.round(rate)))};` +
      select +
      '$sp.Speak([Console]::In.ReadToEnd());';
    return new Promise((resolve, reject) => {
      const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
      });
      let err = '';
      proc.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(`speech failed (${code}): ${err.slice(-200)}`));
        else resolve();
      });
      proc.stdin.end(text, 'utf8');
    });
  }

  voices(): Promise<string> {
    const script =
      'Add-Type -AssemblyName System.Speech;' +
      '$sp = New-Object System.Speech.Synthesis.SpeechSynthesizer;' +
      "$sp.GetInstalledVoices() | ForEach-Object { $v = $_.VoiceInfo; \"$($v.Name) [$($v.Culture)] $($v.Gender)\" }";
    return new Promise((resolve, reject) => {
      const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
      });
      let out = '';
      proc.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
      proc.on('error', reject);
      proc.on('close', () => resolve(out.trim() || 'no voices installed'));
    });
  }
}
