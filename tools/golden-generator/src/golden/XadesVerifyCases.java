package golden;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import com.example.einvoice.certificate.Pkcs12Inspector;
import com.example.einvoice.certificate.SigningMaterial;
import com.example.einvoice.signature.SignatureVerification;
import com.example.einvoice.signature.XadesBesSigner;
import com.example.einvoice.signature.XadesVerifier;
import com.example.einvoice.support.TestCertificates;

/**
 * Resultado de {@code XadesVerifier.verify} de Java para cada {@code signed.xml} de la familia {@code xades} y para
 * variantes alteradas de la factura estándar firmada. Necesita {@code xades/} ya generado. {@code file} es la ruta
 * desde {@code test/golden}; las variantes se guardan en {@code xades-verify/}.
 */
final class XadesVerifyCases {

	private static final String DS_SHA1 = "http://www.w3.org/2000/09/xmldsig#sha1";

	private XadesVerifyCases() {
	}

	static void generate(Path out) throws Exception {
		Path xades = out.resolve("xades");
		Path dir = out.resolve("xades-verify");
		Files.createDirectories(dir);
		List<Object> cases = new ArrayList<>();

		List<String> names;
		try (Stream<Path> entries = Files.list(xades)) {
			names = entries.filter(p -> Files.exists(p.resolve("signed.xml")))
				.map(p -> p.getFileName().toString())
				.sorted()
				.toList();
		}
		for (String name : names) {
			add(cases, "firmado-" + name, "xades/" + name + "/signed.xml",
					Files.readAllBytes(xades.resolve(name).resolve("signed.xml")));
		}

		String signed = Files.readString(xades.resolve("factura-estandar/signed.xml"), StandardCharsets.UTF_8);
		byte[] unsigned = Files.readAllBytes(xades.resolve("factura-estandar/unsigned.xml"));

		variant(cases, dir, "importe-cambiado",
				replace(signed, "<importeTotal>37.00</importeTotal>", "<importeTotal>3.70</importeTotal>"));
		variant(cases, dir, "hora-de-firma-cambiada",
				replace(signed, XadesCases.SIGNING_TIME, "2026-10-30T10:15:30-05:00"));

		SigningMaterial other = Pkcs12Inspector.inspect(TestCertificates.anotherValid(),
				TestCertificates.PASSWORD.toCharArray(), Instant.now());
		String certificate = group(signed, "<ds:X509Certificate>([^<]*)</ds:X509Certificate>");
		String otherCertificate = Base64.getMimeEncoder(76, new byte[] { '\n' })
			.encodeToString(other.certificate().getEncoded());
		variant(cases, dir, "certificado-cambiado", replace(signed, certificate, otherCertificate));

		Instant signingTime = OffsetDateTime.parse(XadesCases.SIGNING_TIME).toInstant();
		SigningMaterial material = Pkcs12Inspector.inspect(Files.readAllBytes(xades.resolve(XadesCases.P12_NAME)),
				TestCertificates.PASSWORD.toCharArray(), signingTime);
		SigningMaterial mismatched = new SigningMaterial(other.privateKey(), material.certificate());
		variant(cases, dir, "firmado-con-otra-clave", new String(
				new XadesBesSigner().sign(unsigned, mismatched, signingTime), StandardCharsets.UTF_8));

		int start = signed.indexOf("<ds:Signature");
		int end = signed.indexOf("</ds:Signature>") + "</ds:Signature>".length();
		String signature = signed.substring(start, end);
		variant(cases, dir, "firma-fuera-de-la-raiz",
				replace(signed.substring(0, start), "</infoFactura>", signature + "</infoFactura>")
						+ signed.substring(end));
		variant(cases, dir, "dos-firmas", signed.substring(0, end) + signature + signed.substring(end));

		String extraReference = "<ds:Reference URI=\"#comprobante\"><ds:DigestMethod Algorithm=\"" + DS_SHA1
				+ "\"/><ds:DigestValue>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</ds:DigestValue></ds:Reference>";
		variant(cases, dir, "cuarta-referencia", replace(signed, "</ds:SignedInfo>", extraReference + "</ds:SignedInfo>"));
		variant(cases, dir, "transformacion-cambiada", replace(signed,
				"http://www.w3.org/2000/09/xmldsig#enveloped-signature",
				"http://www.w3.org/TR/2001/REC-xml-c14n-20010315"));
		variant(cases, dir, "c14n-exclusiva", replace(signed,
				"<ds:CanonicalizationMethod Algorithm=\"http://www.w3.org/TR/2001/REC-xml-c14n-20010315\"/>",
				"<ds:CanonicalizationMethod Algorithm=\"http://www.w3.org/2001/10/xml-exc-c14n#\"/>"));
		variant(cases, dir, "digest-sha256", replace(signed, "<ds:DigestMethod Algorithm=\"" + DS_SHA1 + "\"/>",
				"<ds:DigestMethod Algorithm=\"http://www.w3.org/2001/04/xmlenc#sha256\"/>"));
		variant(cases, dir, "firma-rsa-sha256", replace(signed,
				"<ds:SignatureMethod Algorithm=\"http://www.w3.org/2000/09/xmldsig#rsa-sha1\"/>",
				"<ds:SignatureMethod Algorithm=\"http://www.w3.org/2001/04/xmldsig-more#rsa-sha256\"/>"));
		variant(cases, dir, "raiz-sin-id", replace(signed, " id=\"comprobante\"", ""));
		variant(cases, dir, "keyinfo-sin-id", replace(signed, "<ds:KeyInfo Id=\"" + group(signed, "<ds:KeyInfo Id=\"([^\"]*)\"") + "\">",
				"<ds:KeyInfo>"));
		String signatureValue = group(signed, "<ds:SignatureValue Id=\"[^\"]*\">([^<]*)</ds:SignatureValue>");
		String alteredValue = (signatureValue.charAt(0) == 'A' ? "B" : "A") + signatureValue.substring(1);
		variant(cases, dir, "valor-de-firma-cambiado", replace(signed, signatureValue, alteredValue));
		variant(cases, dir, "valor-de-firma-corto", replace(signed, signatureValue, "AAAA"));
		variant(cases, dir, "serie-cambiada", replace(signed,
				"<ds:X509SerialNumber>" + group(signed, "<ds:X509SerialNumber>([^<]*)<") + "<",
				"<ds:X509SerialNumber>12345<"));
		variant(cases, dir, "emisor-cambiado", replace(signed,
				"<ds:X509IssuerName>" + group(signed, "<ds:X509IssuerName>([^<]*)<") + "<",
				"<ds:X509IssuerName>CN=Otro,O=Pruebas,C=EC<"));
		variant(cases, dir, "sin-signing-certificate", replace(signed,
				signed.substring(signed.indexOf("<etsi:SigningCertificate>"),
						signed.indexOf("</etsi:SigningCertificate>") + "</etsi:SigningCertificate>".length()),
				""));
		variant(cases, dir, "certificado-ilegible", replace(signed, certificate, "AAAA"));
		variant(cases, dir, "sin-signature-method", replace(signed,
				"<ds:SignatureMethod Algorithm=\"http://www.w3.org/2000/09/xmldsig#rsa-sha1\"/>", ""));
		variant(cases, dir, "keyinfo-cambiado", replace(signed, "<ds:Exponent>AQAB</ds:Exponent>",
				"<ds:Exponent>AAEAAQ==</ds:Exponent>"));
		variant(cases, dir, "con-comentario", replace(signed, "<infoFactura>", "<!-- nota --><infoFactura>"));
		variant(cases, dir, "espacio-en-el-comprobante", replace(signed, "<infoFactura>", " <infoFactura>"));

		Files.write(dir.resolve("sin-firmar.xml"), unsigned);
		add(cases, "sin-firmar", "xades-verify/sin-firmar.xml", unsigned);
		variant(cases, dir, "ilegible", "<factura");
		variant(cases, dir, "vacio", "");
		variant(cases, dir, "con-doctype", replace(signed, "?><factura", "?><!DOCTYPE factura [<!ENTITY e \"x\">]><factura"));

		Map<String, Object> json = new LinkedHashMap<>();
		json.put("cases", cases);
		GoldenGenerator.write(out.resolve("xades-verify.json"), json);
	}

	private static void variant(List<Object> cases, Path dir, String name, String xml) throws IOException {
		byte[] bytes = xml.getBytes(StandardCharsets.UTF_8);
		Files.write(dir.resolve(name + ".xml"), bytes);
		add(cases, name, "xades-verify/" + name + ".xml", bytes);
	}

	private static void add(List<Object> cases, String name, String file, byte[] xml) {
		SignatureVerification verification = new XadesVerifier().verify(xml);
		Map<String, Object> entry = new LinkedHashMap<>();
		entry.put("name", name);
		entry.put("file", file);
		entry.put("valid", verification.valid());
		entry.put("errors", new ArrayList<Object>(verification.errors()));
		cases.add(entry);
	}

	/** Sustituye la primera aparición; falla si no está, para que una variante nunca quede igual al original. */
	private static String replace(String text, String target, String replacement) {
		int at = text.indexOf(target);
		if (at < 0) {
			throw new IllegalStateException("No aparece: " + target);
		}
		return text.substring(0, at) + replacement + text.substring(at + target.length());
	}

	private static String group(String text, String regex) {
		Matcher matcher = Pattern.compile(regex).matcher(text);
		if (!matcher.find()) {
			throw new IllegalStateException("No aparece: " + regex);
		}
		return matcher.group(1);
	}

}
