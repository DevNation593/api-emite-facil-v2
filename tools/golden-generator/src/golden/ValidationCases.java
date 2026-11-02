package golden;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import com.example.einvoice.web.TextRules;

import jakarta.validation.ConstraintViolation;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import jakarta.validation.ValidatorFactory;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * Casos de Bean Validation con Hibernate Validator y {@code Locale.ENGLISH} fijado (la imagen Java corre sin
 * {@code LANG}). Cada caso valida una sola restricción; {@code message} es null si el valor es válido.
 */
final class ValidationCases {

	private static final String NO_CONTROL_CHARS = TextRules.NO_CONTROL_CHARS;

	static final class Bean {

		@NotBlank
		String notBlank;

		@NotNull
		String notNull;

		@Size(max = 254)
		String size;

		@Email
		String email;

		@Pattern(regexp = NO_CONTROL_CHARS)
		String noControlChars;

		@Pattern(regexp = "[0-9]{3}")
		String pattern;

		@Min(1)
		Integer min;

		@Max(999_999_999)
		Integer max;

	}

	private ValidationCases() {
	}

	static Map<String, Object> generate() {
		Locale previous = Locale.getDefault();
		Locale.setDefault(Locale.ENGLISH);
		try (ValidatorFactory factory = Validation.buildDefaultValidatorFactory()) {
			Validator validator = factory.getValidator();
			List<Object> cases = new ArrayList<>();

			for (String value : new String[] { "", " ", "\t", "\u3000", "\u00a0", "a", "\u2003", "\u001f", "\u0000", " a ", null }) {
				add(cases, validator, "NotBlank", "notBlank", value);
			}
			for (String value : new String[] { null, "", " ", "x" }) {
				add(cases, validator, "NotNull", "notNull", value);
			}
			for (String value : new String[] { null, "", "a", "a".repeat(254), "a".repeat(255), "\uD83D\uDE00".repeat(127),
					"\uD83D\uDE00".repeat(128), "\uD83D\uDE00".repeat(100) }) {
				add(cases, validator, "Size", "size", value);
			}

			String label63 = "a".repeat(63);
			// Etiquetas de 62 caracteres separadas por punto, cortadas a la longitud pedida.
			String dots = ("a".repeat(62) + ".").repeat(5);
			String backslash = String.valueOf((char) 92);
			String quote = String.valueOf((char) 34);
			for (String value : new String[] { "a@b", "a@b.c", "a.b@c.d", "a..b@c.d", ".a@b.c", "a.@b.c", "a@-b.c", "a@b-.c",
					"a b@c.d", "\"a b\"@c.d", "\u00f1@ejemplo.ec", "a@[192.168.0.1]", "a@ejemplo.ec.", "sin-arroba", "", null,
					"a".repeat(64) + "@b.c", "a".repeat(65) + "@b.c", "a@" + dots.substring(0, 253), "a@" + dots.substring(0, 254),
					"a@" + dots.substring(0, 255), "a@" + dots.substring(0, 256), "a@" + dots.substring(0, 257), "a@" + label63 + ".c",
					"a@" + label63 + "a.c", "a@b..c", "@b.c", "a@", "a@b@c.d", "a+tag@b.c", "a@\u00f1.ec", "a@b_c.d", "a@b.c ",
					" a@b.c", "a@[IPv6:::1]", "a@[300.1.1.1]", "\"a@b\"@c.d", "a" + (char) 92 + "@b@c.d", "a@b.123",
					"a@[::1]", "a@[IPv6:::1", "\u0080@b.c", "a@\u0080.c", "a@ .c", "a@😀.ec", "😀@b.c",
					"a@Über.de", "a@b.中文", "a@" + "ñ".repeat(63) + ".c", "a@" + "ñ".repeat(30) + ".c",
					"A@B.C", "a@[1.2.3]", "a@[1.2.3.4.5]", "a@-.c", quote + quote + "@b.c", quote + "a" + quote + "@b.c",
					"a" + quote + "b@c.d", quote + "a" + backslash + quote + "b" + quote + "@c.d",
					quote + "a" + backslash + backslash + "b" + quote + "@c.d", "a@b.c.", "a@.c", "a@b.-c", "a@1.2.3.4" }) {
				add(cases, validator, "Email", "email", value);
			}

			for (String value : new String[] { null, "", "a", "a b", "\u00f1", "\uD83D\uDE00", "a\u0000", "a\n", "a\r", "a\t",
					"a\u001f", "a\u007f", "a\u0080", "a\u0085", "a\u009f", "a\u00a0", "a\u2028", "a\u2029", "\u0000" }) {
				add(cases, validator, "NoControlChars", "noControlChars", value);
			}

			for (String value : new String[] { null, "", "001", "01", "0001", "a01", "001\n", "١٢٣", " 001" }) {
				add(cases, validator, "Pattern", "pattern", value);
			}
			for (Integer value : new Integer[] { null, 0, 1, 2, -1, Integer.MIN_VALUE, Integer.MAX_VALUE }) {
				add(cases, validator, "Min", "min", value);
			}
			for (Integer value : new Integer[] { null, 0, 999_999_999, 1_000_000_000, -1, Integer.MAX_VALUE }) {
				add(cases, validator, "Max", "max", value);
			}

			Map<String, Object> root = new LinkedHashMap<>();
			root.put("cases", cases);
			return root;
		}
		finally {
			Locale.setDefault(previous);
		}
	}

	private static void add(List<Object> cases, Validator validator, String constraint, String property, Object value) {
		Set<ConstraintViolation<Bean>> violations = validator.validateValue(Bean.class, property, value);
		Map<String, Object> entry = new LinkedHashMap<>();
		entry.put("constraint", constraint);
		entry.put("value", value);
		entry.put("valid", violations.isEmpty());
		entry.put("message", violations.isEmpty() ? null : violations.iterator().next().getMessage());
		cases.add(entry);
	}

}
