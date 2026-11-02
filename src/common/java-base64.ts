const ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Como `Base64.getDecoder().decode` de Java: alfabeto básico, sin espacios ni saltos, y el relleno
 * opcional pero bien formado. `Buffer.from(…, 'base64')` acepta todo eso y más; aquí lo que Java
 * rechaza devuelve null.
 */
export function decodeJavaBase64(text: string): Buffer | null {
  if (!ALPHABET.test(text)) return null;
  const data = text.replace(/=+$/, '');
  const padding = text.length - data.length;
  const rest = data.length % 4;
  // Un carácter suelto no forma un byte; el relleno debe completar el último grupo de cuatro.
  if (rest === 1) return null;
  if (padding > 0 && rest + padding !== 4) return null;
  return Buffer.from(data, 'base64');
}
