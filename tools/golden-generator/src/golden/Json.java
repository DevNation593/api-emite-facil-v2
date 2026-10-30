package golden;

import java.util.List;
import java.util.Map;

/** Escritor JSON mínimo: 2 espacios de sangría, claves en orden de inserción y sin dependencias. */
final class Json {

	private Json() {
	}

	static String write(Object value) {
		StringBuilder out = new StringBuilder();
		append(out, value, 0);
		return out.append('\n').toString();
	}

	private static void append(StringBuilder out, Object value, int depth) {
		if (value == null) {
			out.append("null");
		}
		else if (value instanceof String text) {
			string(out, text);
		}
		else if (value instanceof Number || value instanceof Boolean) {
			out.append(value);
		}
		else if (value instanceof Map<?, ?> map) {
			if (map.isEmpty()) {
				out.append("{}");
				return;
			}
			out.append("{\n");
			int index = 0;
			for (Map.Entry<?, ?> entry : map.entrySet()) {
				indent(out, depth + 1);
				string(out, String.valueOf(entry.getKey()));
				out.append(": ");
				append(out, entry.getValue(), depth + 1);
				out.append(++index < map.size() ? ",\n" : "\n");
			}
			indent(out, depth);
			out.append('}');
		}
		else if (value instanceof List<?> list) {
			if (list.isEmpty()) {
				out.append("[]");
				return;
			}
			out.append("[\n");
			for (int i = 0; i < list.size(); i++) {
				indent(out, depth + 1);
				append(out, list.get(i), depth + 1);
				out.append(i + 1 < list.size() ? ",\n" : "\n");
			}
			indent(out, depth);
			out.append(']');
		}
		else {
			throw new IllegalArgumentException("Tipo no soportado: " + value.getClass());
		}
	}

	private static void indent(StringBuilder out, int depth) {
		out.append("  ".repeat(depth));
	}

	private static void string(StringBuilder out, String text) {
		out.append('"');
		for (int i = 0; i < text.length(); i++) {
			char c = text.charAt(i);
			switch (c) {
				case '"' -> out.append("\\\"");
				case '\\' -> out.append("\\\\");
				case '\n' -> out.append("\\n");
				case '\r' -> out.append("\\r");
				case '\t' -> out.append("\\t");
				default -> {
					if (c < 0x20) {
						out.append(String.format("\\u%04x", (int) c));
					}
					else {
						out.append(c);
					}
				}
			}
		}
		out.append('"');
	}

}
