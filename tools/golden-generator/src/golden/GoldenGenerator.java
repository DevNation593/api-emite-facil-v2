package golden;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Genera los casos golden con el código real de la API Java. Uso: {@code GoldenGenerator <salida> <repo-java> <commit> [familia]}.
 * Los valores de entrada salen de una semilla fija; los aleatorios por naturaleza (IV de AES, sal de Argon2,
 * jti del JWT, API keys, ids de la firma) cambian en cada ejecución, y las pruebas de Node los leen del resultado.
 */
public final class GoldenGenerator {

	/** Semilla de todos los valores de entrada reproducibles. */
	static final long SEED = 20261029L;

	private GoldenGenerator() {
	}

	public static void main(String[] args) throws Exception {
		if (args.length < 3 || args.length > 4) {
			throw new IllegalArgumentException("Uso: GoldenGenerator <salida> <repo-java> <commit> [familia]");
		}
		Path out = Path.of(args[0]);
		Files.createDirectories(out);

		// Con familia solo se genera esa y no se toca el resto de fixtures ni SOURCE.json.
		if (args.length == 4) {
			switch (args[3]) {
				case "bean-validation" -> write(out.resolve("bean-validation.json"), ValidationCases.generate());
				case "certificates" -> CertificateCases.generate(out.resolve("certificates"));
				case "xsd" -> XsdCases.generate(out, Path.of(args[1]));
				default -> throw new IllegalArgumentException("Familia desconocida: " + args[3]);
			}
			System.out.println("Familia " + args[3] + " generada en " + out.toAbsolutePath());
			return;
		}

		write(out.resolve("access-key.json"), AccessKeyCases.generate());
		write(out.resolve("aes-gcm.json"), AesGcmCases.generate());
		write(out.resolve("argon2.json"), Argon2Cases.generate());
		write(out.resolve("jwt.json"), JwtCases.generate());
		write(out.resolve("api-key.json"), ApiKeyCases.generate());
		write(out.resolve("bean-validation.json"), ValidationCases.generate());
		XadesCases.generate(out.resolve("xades"));
		CertificateCases.generate(out.resolve("certificates"));
		XsdCases.generate(out, Path.of(args[1]));

		Map<String, Object> source = new LinkedHashMap<>();
		source.put("javaRepoCommit", args[2]);
		source.put("javaVersion", System.getProperty("java.version"));
		source.put("generatedAt", Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS).toString());
		write(out.resolve("SOURCE.json"), source);
		System.out.println("Casos golden generados en " + out.toAbsolutePath());
	}

	static void write(Path file, Object json) throws IOException {
		Files.createDirectories(file.getParent());
		Files.write(file, Json.write(json).getBytes(StandardCharsets.UTF_8));
	}

}
