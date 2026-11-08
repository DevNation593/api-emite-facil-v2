package golden;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.example.einvoice.xml.DocumentSchema;
import com.example.einvoice.xml.DocumentSchemas;
import com.example.einvoice.xml.EnvelopeRules;
import com.example.einvoice.xml.EnvelopeViolation;
import com.example.einvoice.xml.InvoiceXmlBuilder;
import com.example.einvoice.xml.InvoiceXmlFixtures;
import com.example.einvoice.xml.ValidationResult;
import com.example.einvoice.xml.XsdValidator;

/**
 * Validación XSD y reglas del sobre de Java sobre los XML de ejemplo del SRI y sobre variantes de la
 * factura estándar. Para cada XML anota si es válido y, si lo es, las violaciones del sobre.
 * {@code file} es la ruta desde la raíz del repo de Node: los ejemplos del SRI se leen de {@code resources/xsd}
 * y las variantes se escriben en {@code test/golden/xsd}.
 */
final class XsdCases {

	private static final String SAMPLE_BASE = "resources/xsd/";

	private static final String VARIANT_BASE = "test/golden/xsd/";

	private static final DocumentSchema STANDARD_SCHEMA = DocumentSchema.INVOICE_1_1_0;

	private XsdCases() {
	}

	static void generate(Path out, Path javaRepo) throws IOException {
		XsdValidator validator = new XsdValidator(new DocumentSchemas());
		Path dir = out.resolve("xsd");
		Files.createDirectories(dir);
		List<Object> cases = new ArrayList<>();

		for (DocumentSchema schema : DocumentSchema.values()) {
			Path sample = javaRepo.resolve("src/main/resources").resolve(schema.sampleResource());
			cases.add(run(validator, "muestra-" + schema.name(), SAMPLE_BASE + schema.sampleResource().substring(4),
					Files.readAllBytes(sample), schema));
		}

		String standard = new String(InvoiceXmlBuilder.build(InvoiceXmlFixtures.standard()), StandardCharsets.UTF_8);
		InvoiceXmlFixtures.Builder longName = InvoiceXmlFixtures.builder();
		longName.legalName = "R".repeat(301);
		String missingTaxes = standard.replaceAll("<totalConImpuestos>.*</totalConImpuestos>", "");
		String keyOnly = InvoiceXmlFixtures.ACCESS_KEY;

		Map<String, String> variants = new LinkedHashMap<>();
		variants.put("factura-estandar", standard);
		variants.put("razon-social-301", new String(InvoiceXmlBuilder.build(longName.build()), StandardCharsets.UTF_8));
		variants.put("salto-de-linea-comprador", standard.replace("María Pérez", "María\nPérez"));
		variants.put("fecha-iso", standard.replace("<fechaEmision>07/10/2026", "<fechaEmision>2026-10-07"));
		variants.put("sin-total-con-impuestos", missingTaxes);
		variants.put("cod-doc-04", standard.replace("<codDoc>01</codDoc>", "<codDoc>04</codDoc>"));
		variants.put("version-2-0-0", standard.replace("version=\"1.1.0\"", "version=\"2.0.0\""));
		variants.put("schema-location-en-hijo",
				standard.replace("<infoTributaria>", "<infoTributaria xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\""
						+ " xsi:noNamespaceSchemaLocation=\"http://127.0.0.1:9/evil.xsd\">"));
		variants.put("clave-digito-incorrecto", standard.replace(keyOnly, keyOnly.substring(0, 48) + "7"));
		variants.put("clave-otro-secuencial", standard.replace("<secuencial>000000123</secuencial>",
				"<secuencial>000000124</secuencial>"));
		variants.put("doctype-entidad-externa",
				"<?xml version=\"1.0\"?><!DOCTYPE factura [<!ENTITY x SYSTEM \"file:///etc/passwd\">]>"
						+ "<factura id=\"comprobante\" version=\"1.1.0\">&x;</factura>");
		variants.put("vacio", "");
		variants.put("sin-cerrar", "<factura");

		for (Map.Entry<String, String> variant : variants.entrySet()) {
			byte[] bytes = variant.getValue().getBytes(StandardCharsets.UTF_8);
			Files.write(dir.resolve(variant.getKey() + ".xml"), bytes);
			cases.add(run(validator, variant.getKey(), VARIANT_BASE + variant.getKey() + ".xml", bytes,
					STANDARD_SCHEMA));
		}

		Map<String, Object> root = new LinkedHashMap<>();
		root.put("cases", cases);
		GoldenGenerator.write(out.resolve("xsd.json"), root);
	}

	private static Map<String, Object> run(XsdValidator validator, String name, String file, byte[] xml,
			DocumentSchema schema) {
		ValidationResult result = validator.validate(xml, schema);
		Object violations = null;
		if (result.valid()) {
			try {
				Set<EnvelopeViolation> found = EnvelopeRules.check(xml, schema);
				violations = found.stream().map(Enum::name).sorted().toList();
			}
			catch (IllegalArgumentException ex) {
				violations = "unreadable";
			}
		}
		Map<String, Object> entry = new LinkedHashMap<>();
		entry.put("name", name);
		entry.put("file", file);
		entry.put("schema", schema.name());
		entry.put("valid", result.valid());
		entry.put("violations", violations);
		return entry;
	}

}
