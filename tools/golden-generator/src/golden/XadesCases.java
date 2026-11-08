package golden;

import java.io.IOException;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.w3c.dom.Document;

import com.example.einvoice.billing.DocumentEnvelope;
import com.example.einvoice.certificate.Pkcs12Inspector;
import com.example.einvoice.certificate.SigningMaterial;
import com.example.einvoice.notes.CreditNoteContent;
import com.example.einvoice.notes.CreditNoteXmlBuilder;
import com.example.einvoice.notes.DebitNoteContent;
import com.example.einvoice.notes.DebitNoteXmlBuilder;
import com.example.einvoice.signature.SignatureVerification;
import com.example.einvoice.signature.XadesBesSigner;
import com.example.einvoice.signature.XadesVerifier;
import com.example.einvoice.support.TestCertificates;
import com.example.einvoice.xml.InvoiceXmlBuilder;
import com.example.einvoice.xml.InvoiceXmlData;
import com.example.einvoice.xml.InvoiceXmlFixtures;
import com.example.einvoice.xml.SecureXml;

/**
 * Comprobantes sin firmar y firmados XAdES-BES con un .p12 de prueba. Aborta si el verificador Java no acepta la
 * firma. {@code meta.json} guarda los ocho números aleatorios de los {@code Id} en el orden en que el firmante los
 * pide, para que la prueba de Node repita la firma byte a byte. Además, {@code serializacion-jdk/} guarda un XML
 * con caracteres y construcciones de borde leído con {@code SecureXml} y escrito con el {@code Transformer} de
 * {@code XadesBesSigner.serialize} (privado: se invoca por reflexión).
 */
final class XadesCases {

	static final String SIGNING_TIME = "2026-10-29T10:15:30-05:00";

	static final String P12_NAME = "certificado-prueba.p12";

	/** Inicio fijo de la vigencia: el certificado cubre {@link #SIGNING_TIME} aunque se regenere más tarde. */
	private static final String P12_START = "2026/01/01 00:00:00";

	private static final int P12_VALIDITY_DAYS = 3650;

	/** Los {@code Id} de la firma, en el orden en que {@code XadesBesSigner} pide sus números. */
	private static final List<Pattern> ID_PATTERNS = List.of(Pattern.compile(" Id=\"Signature(\\d+)\""),
			Pattern.compile(" Id=\"Signature\\d+-SignedProperties(\\d+)\""),
			Pattern.compile(" Id=\"Certificate(\\d+)\""), Pattern.compile(" Id=\"Reference-ID-(\\d+)\""),
			Pattern.compile(" Id=\"SignedPropertiesID(\\d+)\""),
			Pattern.compile(" Id=\"Signature-SignedInfo(\\d+)\""),
			Pattern.compile(" Id=\"Signature\\d+-Object(\\d+)\""), Pattern.compile(" Id=\"SignatureValue(\\d+)\""));

	private XadesCases() {
	}

	static void generate(Path dir) throws Exception {
		// El Transformer escribe los saltos de línea del texto con este separador; run.mjs fija el de Linux.
		if (!"\n".equals(System.lineSeparator())) {
			throw new IllegalStateException("La firma se genera con -Dline.separator=\\n (lo fija run.mjs)");
		}
		byte[] p12 = p12();
		Files.createDirectories(dir);
		Files.write(dir.resolve(P12_NAME), p12);
		Instant signingTime = OffsetDateTime.parse(SIGNING_TIME).toInstant();
		SigningMaterial material = Pkcs12Inspector.inspect(p12, TestCertificates.PASSWORD.toCharArray(), signingTime);

		InvoiceXmlFixtures.Builder withProvider = InvoiceXmlFixtures.builder();
		withProvider.providerRuc = "1790012345001";

		write(dir, "factura-estandar", InvoiceXmlBuilder.build(InvoiceXmlFixtures.standard()), material, signingTime);
		write(dir, "factura-con-ruc-proveedor", InvoiceXmlBuilder.build(withProvider.build()), material, signingTime);

		Object[] credit = DocumentCases.creditNotes().get("nota-credito-sobre-factura");
		write(dir, "nota-credito-sobre-factura",
				CreditNoteXmlBuilder.build((DocumentEnvelope) credit[0], (CreditNoteContent) credit[1]), material,
				signingTime);
		Object[] debit = DocumentCases.debitNotes().get("nota-debito-dos-tarifas");
		write(dir, "nota-debito-dos-tarifas",
				DebitNoteXmlBuilder.build((DocumentEnvelope) debit[0], (DebitNoteContent) debit[1]), material,
				signingTime);

		// Sin pasar por el XSD: la dirección con saltos de línea no es válida, pero el firmante no lo comprueba.
		InvoiceXmlFixtures.Builder special = InvoiceXmlFixtures.builder();
		special.legalName = "Ñandú & Hijos <\"S.A.\"> 'O'Brien' ñ é 😀";
		// Tabulador, controles C1 (U+007F, U+0085, U+009F) y el separador de línea U+2028.
		special.tradeName = "Andina\tC1 " + (char) 0x7f + (char) 0x85 + (char) 0x9f + " sep " + (char) 0x2028 + " fin";
		special.customerAddress = "Av. República\r\nQuito\rNorte\nEdificio";
		special.lines = new ArrayList<>(List.of(
				new InvoiceXmlData.Line("SRV-001", "Café & té <frío> \"doble\" 'simple' 😀", InvoiceXmlFixtures.d("2"),
						InvoiceXmlFixtures.d("10.00"), InvoiceXmlFixtures.d("0.00"), InvoiceXmlFixtures.d("20.00"), "2",
						"4", InvoiceXmlFixtures.d("15.00"), InvoiceXmlFixtures.d("3.00")),
				special.lines.get(1)));
		write(dir, "factura-caracteres-especiales", InvoiceXmlBuilder.build(special.build()), material, signingTime);

		InvoiceXmlFixtures.Builder large = InvoiceXmlFixtures.builder();
		InvoiceXmlData.Line line = new InvoiceXmlData.Line("SRV-001", "Servicio de consultoría",
				InvoiceXmlFixtures.d("2"), InvoiceXmlFixtures.d("10.00"), InvoiceXmlFixtures.d("0.00"),
				InvoiceXmlFixtures.d("20.00"), "2", "4", InvoiceXmlFixtures.d("15.00"), InvoiceXmlFixtures.d("3.00"));
		large.lines = new ArrayList<>();
		for (int i = 0; i < 500; i++) {
			large.lines.add(line);
		}
		write(dir, "factura-500-lineas", InvoiceXmlBuilder.build(large.build()), material, signingTime);

		serialization(dir.resolve("serializacion-jdk"));
	}

	private static void write(Path dir, String name, byte[] unsigned, SigningMaterial material, Instant signingTime)
			throws IOException {
		byte[] signed = new XadesBesSigner().sign(unsigned, material, signingTime);
		SignatureVerification verification = new XadesVerifier().verify(signed);
		if (!verification.valid()) {
			throw new IllegalStateException("La firma de " + name + " no es válida: " + verification.errors());
		}
		Path caseDir = dir.resolve(name);
		Files.createDirectories(caseDir);
		Files.write(caseDir.resolve("unsigned.xml"), unsigned);
		Files.write(caseDir.resolve("signed.xml"), signed);
		Map<String, Object> meta = new LinkedHashMap<>();
		meta.put("signingTime", SIGNING_TIME);
		meta.put("p12", P12_NAME);
		meta.put("p12Password", TestCertificates.PASSWORD);
		meta.put("numbers", numbers(name, new String(signed, StandardCharsets.UTF_8)));
		GoldenGenerator.write(caseDir.resolve("meta.json"), meta);
	}

	private static List<Object> numbers(String name, String signed) {
		List<Object> numbers = new ArrayList<>();
		for (Pattern pattern : ID_PATTERNS) {
			Matcher matcher = pattern.matcher(signed);
			if (!matcher.find()) {
				throw new IllegalStateException(name + ": falta el Id " + pattern);
			}
			numbers.add(Integer.parseInt(matcher.group(1)));
			if (matcher.find()) {
				throw new IllegalStateException(name + ": el Id " + pattern + " aparece más de una vez");
			}
		}
		return numbers;
	}

	/**
	 * Un XML con los casos de borde de la serialización del JDK: atributos desordenados, declaraciones de espacio de
	 * nombres repetidas, elementos vacíos, comentarios, instrucciones de proceso, CDATA, finales de línea y, como
	 * referencias numéricas, una muestra de caracteres en texto y en atributos (controles C1, separadores Unicode,
	 * extremos del BMP y caracteres fuera de él).
	 */
	private static void serialization(Path dir) throws Exception {
		StringBuilder in = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\"?><!--antes--><?antes datos?>");
		in.append("<r z=\"1\" a=\"2\" xmlns:b=\"urn:b\" xmlns:a=\"urn:a\" b:x=\"3\" A=\"4\" t=\"x\ty\nz\r\nw\">");
		in.append("<x></x> <a:s xmlns:a=\"urn:a\" xmlns:c=\"urn:c\"/><t xmlns=\"urn:t\"><u/></t>");
		in.append("<!-- comentario & < > \" ' é 😀 --><?pi a & < > \" ' é 😀?>");
		in.append("<![CDATA[p]]]]><![CDATA[>q & < > \" ' é 😀 \t]]>");
		in.append("<y>a&#13;b\r\nc\rd\ne\tf &amp; &lt; &gt; &quot; &apos; ]]&gt;</y>");
		for (int[] range : new int[][] { { 0x9, 0xA }, { 0xD, 0xD }, { 0x20, 0x2FF }, { 0x2000, 0x206F },
				{ 0xD7F0, 0xD7FF }, { 0xE000, 0xE00F }, { 0xFEFF, 0xFEFF }, { 0xFFF0, 0xFFFD }, { 0x10000, 0x1000F },
				{ 0x1F600, 0x1F600 }, { 0x10FFFF, 0x10FFFF } }) {
			for (int c = range[0]; c <= range[1]; c++) {
				String ref = "&#x" + Integer.toHexString(c) + ";";
				in.append("<c v=\"").append(ref).append("\">").append(ref).append("</c>");
			}
		}
		in.append("</r><!--después-->");
		byte[] input = in.toString().getBytes(StandardCharsets.UTF_8);
		Document document = SecureXml.parse(input);
		Method serialize = XadesBesSigner.class.getDeclaredMethod("serialize", Document.class);
		serialize.setAccessible(true);
		byte[] output;
		try {
			output = (byte[]) serialize.invoke(null, document);
		}
		catch (InvocationTargetException ex) {
			throw new IllegalStateException(ex.getCause());
		}
		Files.createDirectories(dir);
		Files.write(dir.resolve("input.xml"), input);
		Files.write(dir.resolve("output.xml"), output);
	}

	/** RSA 2048 con uso digitalSignature y diez años de vigencia desde una fecha fija, para que el golden no caduque. */
	private static byte[] p12() throws IOException, InterruptedException {
		Path work = Files.createTempDirectory("golden-xades");
		try {
			Path store = work.resolve("store.p12");
			Path log = work.resolve("keytool.log");
			List<String> command = List.of(Path.of(System.getProperty("java.home"), "bin", "keytool").toString(),
					"-genkeypair", "-alias", "firma", "-keyalg", "RSA", "-keysize", "2048", "-sigalg", "SHA256withRSA",
					"-dname", "CN=Emisor de Pruebas firma, O=Pruebas, C=EC", "-startdate", P12_START, "-validity",
					String.valueOf(P12_VALIDITY_DAYS), "-storetype", "PKCS12", "-keystore", store.toString(),
					"-storepass", TestCertificates.PASSWORD, "-ext", "KeyUsage=digitalSignature");
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
		finally {
			try (var files = Files.list(work)) {
				for (Path file : files.toList()) {
					Files.deleteIfExists(file);
				}
			}
			Files.deleteIfExists(work);
		}
	}

}
