package golden;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.example.einvoice.identity.Passwords;

/** Hashes Argon2id de {@code Passwords.hash}; la sal es aleatoria, así que cada ejecución da hashes distintos. */
final class Argon2Cases {

	private Argon2Cases() {
	}

	static Map<String, Object> generate() {
		Passwords passwords = new Passwords();
		String alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
		StringBuilder long128 = new StringBuilder();
		for (int i = 0; i < 128; i++) {
			long128.append(alphabet.charAt((i * 7) % alphabet.length()));
		}
		List<String> inputs = List.of("Abcdef123456", "clave-segura-de-prueba", "contraseña-áéíóú-ÁÉÍÓÚ-ñandú",
				"Año-nuevo-Ñoño-2026", "clave-con-emoji-🔐-ok", "con espacios y símbolos !@#$%^&*()",
				long128.toString());
		List<Object> cases = new ArrayList<>();
		for (String password : inputs) {
			String hash = passwords.hash(password);
			if (!passwords.matches(password, hash)) {
				throw new IllegalStateException("El hash de referencia no verifica su contraseña");
			}
			Map<String, Object> entry = new LinkedHashMap<>();
			entry.put("password", password);
			entry.put("hash", hash);
			cases.add(entry);
		}
		Map<String, Object> root = new LinkedHashMap<>();
		root.put("cases", cases);
		return root;
	}

}
