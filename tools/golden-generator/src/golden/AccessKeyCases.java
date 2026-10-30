package golden;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;

import com.example.einvoice.sequence.AccessKey;
import com.example.einvoice.sequence.AccessKeyParts;

/** Claves de acceso: la clave y su base de 48 dígitos salen de {@code AccessKeyParts}; la validez, de {@code AccessKey.valid}. */
final class AccessKeyCases {

	private static final int MIN_CASES = 50;

	private static final int MIN_PER_EDGE = 3;

	private static final String[] DOCUMENT_TYPES = { "01", "03", "04", "05", "06", "07" };

	private AccessKeyCases() {
	}

	static Map<String, Object> generate() {
		Random random = new Random(GoldenGenerator.SEED);
		List<AccessKeyParts> parts = new ArrayList<>();
		// Vector del documento 06 de la API Java y los extremos del secuencial.
		parts.add(new AccessKeyParts(LocalDate.of(2026, 10, 7), "01", "1790012345001", "1", "001", "002", 123,
				"12345678", "1"));
		parts.add(new AccessKeyParts(LocalDate.of(2026, 1, 1), "01", "1790012345001", "2", "001", "001", 1,
				"00000001", "1"));
		parts.add(new AccessKeyParts(LocalDate.of(2026, 12, 31), "07", "0992345678001", "1", "999", "999",
				999_999_999, "99999999", "1"));

		int mod10 = 0;
		int mod11 = 0;
		for (AccessKeyParts p : parts) {
			mod10 += remainder(p) == 10 ? 1 : 0;
			mod11 += remainder(p) == 11 ? 1 : 0;
		}
		// Se siguen generando candidatos hasta tener 50 casos y al menos 3 de cada borde del módulo 11;
		// pasado el mínimo solo se aceptan los que aportan a un borde pendiente.
		for (int attempt = 0; attempt < 1_000_000 && !(parts.size() >= MIN_CASES && mod10 >= MIN_PER_EDGE
				&& mod11 >= MIN_PER_EDGE); attempt++) {
			AccessKeyParts candidate = randomParts(random);
			int raw = remainder(candidate);
			boolean needed = (raw == 10 && mod10 < MIN_PER_EDGE) || (raw == 11 && mod11 < MIN_PER_EDGE);
			if (parts.size() < MIN_CASES || needed) {
				parts.add(candidate);
				mod10 += raw == 10 ? 1 : 0;
				mod11 += raw == 11 ? 1 : 0;
			}
		}
		if (parts.size() < MIN_CASES || mod10 < MIN_PER_EDGE || mod11 < MIN_PER_EDGE) {
			throw new IllegalStateException("No se hallaron casos de módulo 11 con resultado 10 y 11");
		}

		List<Object> cases = new ArrayList<>();
		for (AccessKeyParts p : parts) {
			Map<String, Object> c = new LinkedHashMap<>();
			c.put("issueDate", p.issueDate().toString());
			c.put("documentType", p.documentType());
			c.put("ruc", p.ruc());
			c.put("environment", p.environment());
			c.put("establishment", p.establishment());
			c.put("emissionPoint", p.emissionPoint());
			c.put("sequence", p.sequence());
			c.put("numericCode", p.numericCode());
			c.put("emissionType", p.emissionType());
			c.put("base48", p.toBase48());
			c.put("accessKey", p.toAccessKey());
			cases.add(c);
		}

		List<Object> validity = new ArrayList<>();
		for (int i = 0; i < 5; i++) {
			String key = parts.get(i).toAccessKey();
			validity.add(validity(key));
			validity.add(validity(withChangedDigit(key, 10 + i * 7)));
		}
		String first = parts.get(0).toAccessKey();
		validity.add(validity(first.substring(0, 48)));
		validity.add(validity(first + "0"));
		validity.add(validity(parts.get(1).toAccessKey() + "7"));
		validity.add(validity(first.substring(0, 20) + "A" + first.substring(21)));
		validity.add(validity(parts.get(2).toBase48() + "X"));
		validity.add(validity(""));
		validity.add(validity(" " + first.substring(1)));
		validity.add(validity("0".repeat(49)));

		Map<String, Object> root = new LinkedHashMap<>();
		root.put("cases", cases);
		root.put("validity", validity);
		return root;
	}

	private static AccessKeyParts randomParts(Random random) {
		LocalDate date = LocalDate.of(2020, 1, 1).plusDays(random.nextInt(3_000));
		String ruc = digits(random, 10) + "001";
		return new AccessKeyParts(date, DOCUMENT_TYPES[random.nextInt(DOCUMENT_TYPES.length)], ruc,
				String.valueOf(1 + random.nextInt(2)), pad(1 + random.nextInt(999), 3), pad(1 + random.nextInt(999), 3),
				1 + random.nextInt(999_999_999), digits(random, 8), String.valueOf(1 + random.nextInt(2)));
	}

	/**
	 * Resultado crudo de 11 - (suma % 11), antes de que Java lo pase a dígito (10 pasa a 1 y 11 a 0). Es solo la
	 * herramienta para buscar los bordes; la clave que se guarda es siempre la de {@code AccessKey.build}.
	 */
	private static int remainder(AccessKeyParts parts) {
		String base = parts.toBase48();
		int sum = 0;
		int factor = 2;
		for (int i = base.length() - 1; i >= 0; i--) {
			sum += (base.charAt(i) - '0') * factor;
			factor = factor == 7 ? 2 : factor + 1;
		}
		return 11 - (sum % 11);
	}

	private static Map<String, Object> validity(String key) {
		Map<String, Object> entry = new LinkedHashMap<>();
		entry.put("key", key);
		entry.put("valid", AccessKey.valid(key));
		return entry;
	}

	private static String withChangedDigit(String key, int index) {
		char original = key.charAt(index);
		char changed = (char) ('0' + (original - '0' + 1) % 10);
		return key.substring(0, index) + changed + key.substring(index + 1);
	}

	private static String digits(Random random, int count) {
		StringBuilder out = new StringBuilder(count);
		for (int i = 0; i < count; i++) {
			out.append(random.nextInt(10));
		}
		return out.toString();
	}

	private static String pad(int value, int width) {
		return String.format(Locale.ROOT, "%0" + width + "d", value);
	}

}
