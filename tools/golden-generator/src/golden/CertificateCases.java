package golden;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.TimeUnit;

import com.example.einvoice.certificate.CertificateRejectedException;
import com.example.einvoice.certificate.Pkcs12Inspector;
import com.example.einvoice.certificate.SigningMaterial;
import com.example.einvoice.support.TestCertificates;

/**
 * Archivos PKCS#12 creados con keytool y leídos con {@code Pkcs12Inspector} de Java en un instante fijo. Un
 * certificado vigente deja de serlo con el tiempo: la prueba de Node repite la lectura en ese mismo instante.
 * Además de los casos de {@code TestCertificates}, cubre lo que traen los certificados reales: clave EC, una
 * contraseña con eñe, el formato heredado (3DES y RC2) y un DN con comas, tildes, SERIALNUMBER y correo.
 */
final class CertificateCases {

	private static final String PASSWORD = TestCertificates.PASSWORD;

	private CertificateCases() {
	}

	static void generate(Path dir) throws Exception {
		Files.createDirectories(dir);
		Instant inspectedAt = Instant.now().truncatedTo(ChronoUnit.SECONDS);
		List<Object> cases = new ArrayList<>();
		add(cases, dir, inspectedAt, "valido", TestCertificates.valid(), PASSWORD);
		add(cases, dir, inspectedAt, "sin-uso-de-clave", TestCertificates.withoutKeyUsage(), PASSWORD);
		add(cases, dir, inspectedAt, "firma-y-cifrado", TestCertificates.signingAndEncryptionKeys(), PASSWORD);
		add(cases, dir, inspectedAt, "caducado", TestCertificates.expired(), PASSWORD);
		add(cases, dir, inspectedAt, "futuro", TestCertificates.notYetValid(), PASSWORD);
		add(cases, dir, inspectedAt, "clave-corta", TestCertificates.shortKey(), PASSWORD);
		add(cases, dir, inspectedAt, "dos-claves-de-firma", TestCertificates.twoSigningKeys(), PASSWORD);
		add(cases, dir, inspectedAt, "sin-clave-privada", TestCertificates.withoutPrivateKey(), PASSWORD);
		add(cases, dir, inspectedAt, "clave-cambiada", TestCertificates.mismatchedKey(), PASSWORD);
		add(cases, dir, inspectedAt, "contrasena-equivocada", TestCertificates.valid(), "otra-contrasena");

		Path work = Files.createTempDirectory("golden-certificates");
		try {
			add(cases, dir, inspectedAt, "clave-ec",
					keytool(work, "ec", PASSWORD, List.of(), "-keyalg", "EC", "-groupname", "secp256r1", "-sigalg",
							"SHA256withECDSA", "-dname", "CN=Emisor EC, O=Pruebas, C=EC", "-ext",
							"KeyUsage=digitalSignature"),
					PASSWORD);
			add(cases, dir, inspectedAt, "contrasena-con-enie",
					keytool(work, "enie", "clave-con-ñ", List.of(), "-keyalg", "RSA", "-keysize", "2048", "-dname",
							"CN=Emisor Eñe, O=Pruebas, C=EC", "-ext", "KeyUsage=digitalSignature"),
					"clave-con-ñ");
			add(cases, dir, inspectedAt, "heredado",
					keytool(work, "legacy", PASSWORD, List.of("-J-Dkeystore.pkcs12.legacy"), "-keyalg", "RSA",
							"-keysize", "2048", "-dname", "CN=Emisor Heredado, O=Pruebas, C=EC", "-ext",
							"KeyUsage=digitalSignature"),
					PASSWORD);
			add(cases, dir, inspectedAt, "dn-especial",
					keytool(work, "dn", PASSWORD, List.of(), "-keyalg", "RSA", "-keysize", "2048", "-dname",
							"CN=José Pérez\\, Ñandú, OU=Firma, O=Pruebas S.A., L=Quito, ST=Pichincha, C=EC,"
									+ " SERIALNUMBER=0912345678, EMAILADDRESS=jose@example.ec",
							"-ext", "KeyUsage=digitalSignature,nonRepudiation"),
					PASSWORD);
			add(cases, dir, inspectedAt, "firma-pss",
					keytool(work, "pss", PASSWORD, List.of(), "-keyalg", "RSA", "-keysize", "2048", "-sigalg",
							"RSASSA-PSS", "-dname", "CN=Emisor PSS, O=Pruebas, C=EC", "-ext",
							"KeyUsage=digitalSignature"),
					PASSWORD);
			// Válido pero costoso de leer: la prueba de Node comprueba que no bloquea el proceso.
			add(cases, dir, inspectedAt, "iteraciones-altas",
					keytool(work, "high", PASSWORD,
							List.of("-J-Dkeystore.pkcs12.macIterationCount=200000",
									"-J-Dkeystore.pkcs12.keyPbeIterationCount=200000",
									"-J-Dkeystore.pkcs12.certPbeIterationCount=200000"),
							"-keyalg", "RSA", "-keysize", "2048", "-dname", "CN=Emisor Lento, O=Pruebas, C=EC", "-ext",
							"KeyUsage=digitalSignature"),
					PASSWORD);
		}
		finally {
			try (var files = Files.list(work)) {
				for (Path file : files.toList()) {
					Files.deleteIfExists(file);
				}
			}
			Files.deleteIfExists(work);
		}
		byte[] garbage = new byte[512];
		new Random(GoldenGenerator.SEED).nextBytes(garbage);
		add(cases, dir, inspectedAt, "basura", garbage, PASSWORD);

		Map<String, Object> root = new LinkedHashMap<>();
		root.put("inspectedAt", inspectedAt.toString());
		root.put("cases", cases);
		GoldenGenerator.write(dir.resolve("certificates.json"), root);
	}

	private static void add(List<Object> cases, Path dir, Instant at, String name, byte[] p12, String password)
			throws Exception {
		String file = name + ".p12";
		Files.write(dir.resolve(file), p12);
		Map<String, Object> result = new LinkedHashMap<>();
		try {
			SigningMaterial material = Pkcs12Inspector.inspect(p12, password.toCharArray(), at);
			X509Certificate certificate = material.certificate();
			result.put("subject", certificate.getSubjectX500Principal().getName());
			result.put("issuer", certificate.getIssuerX500Principal().getName());
			result.put("serialNumber", certificate.getSerialNumber().toString());
			result.put("fingerprintSha256",
					HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded())));
			result.put("validFrom", certificate.getNotBefore().toInstant().toString());
			result.put("validTo", certificate.getNotAfter().toInstant().toString());
		}
		catch (CertificateRejectedException ex) {
			result.put("errorCode", ex.errorCode());
			result.put("message", ex.getMessage());
		}
		Map<String, Object> entry = new LinkedHashMap<>();
		entry.put("name", name);
		entry.put("file", file);
		entry.put("password", password);
		entry.put("result", result);
		cases.add(entry);
	}

	/** Un almacén con un par de claves; {@code flags} van antes del comando (opciones de la JVM de keytool). */
	private static byte[] keytool(Path work, String name, String password, List<String> flags, String... options)
			throws IOException, InterruptedException {
		Path store = work.resolve(name + ".p12");
		List<String> command = new ArrayList<>();
		command.add(Path.of(System.getProperty("java.home"), "bin", "keytool").toString());
		command.addAll(flags);
		command.addAll(List.of("-genkeypair", "-alias", "firma", "-startdate", "-1d", "-validity", "365",
				"-storetype", "PKCS12", "-keystore", store.toString(), "-storepass", password));
		command.addAll(List.of(options));
		Path log = work.resolve(name + ".log");
		ProcessBuilder builder = new ProcessBuilder(command).redirectErrorStream(true)
			.redirectOutput(ProcessBuilder.Redirect.appendTo(log.toFile()));
		builder.environment().remove("JAVA_TOOL_OPTIONS");
		Process process = builder.start();
		if (!process.waitFor(60, TimeUnit.SECONDS) || process.exitValue() != 0) {
			process.destroyForcibly();
			throw new IllegalStateException("keytool falló: " + Files.readString(log));
		}
		return Files.readAllBytes(store);
	}

}
