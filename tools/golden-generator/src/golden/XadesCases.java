package golden;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.Map;

import com.example.einvoice.certificate.Pkcs12Inspector;
import com.example.einvoice.certificate.SigningMaterial;
import com.example.einvoice.signature.SignatureVerification;
import com.example.einvoice.signature.XadesBesSigner;
import com.example.einvoice.signature.XadesVerifier;
import com.example.einvoice.support.TestCertificates;
import com.example.einvoice.xml.InvoiceXmlBuilder;
import com.example.einvoice.xml.InvoiceXmlData;
import com.example.einvoice.xml.InvoiceXmlFixtures;

/** Facturas sin firmar y firmadas XAdES-BES con un .p12 de prueba. Aborta si el verificador Java no acepta la firma. */
final class XadesCases {

	static final String SIGNING_TIME = "2026-10-29T10:15:30-05:00";

	static final String P12_NAME = "certificado-prueba.p12";

	private XadesCases() {
	}

	static void generate(Path dir) throws IOException {
		byte[] p12 = TestCertificates.valid();
		Files.createDirectories(dir);
		Files.write(dir.resolve(P12_NAME), p12);
		SigningMaterial material = Pkcs12Inspector.inspect(p12, TestCertificates.PASSWORD.toCharArray(), Instant.now());
		Instant signingTime = OffsetDateTime.parse(SIGNING_TIME).toInstant();

		InvoiceXmlFixtures.Builder withProvider = InvoiceXmlFixtures.builder();
		withProvider.providerRuc = "1790012345001";

		write(dir, "factura-estandar", InvoiceXmlFixtures.standard(), material, signingTime);
		write(dir, "factura-con-ruc-proveedor", withProvider.build(), material, signingTime);
	}

	private static void write(Path dir, String name, InvoiceXmlData data, SigningMaterial material, Instant signingTime)
			throws IOException {
		byte[] unsigned = InvoiceXmlBuilder.build(data);
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
		GoldenGenerator.write(caseDir.resolve("meta.json"), meta);
	}

}
