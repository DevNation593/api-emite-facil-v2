package golden;

import java.io.IOException;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.openpdf.text.pdf.Barcode128;

import com.example.einvoice.billing.DocumentEnvelope;
import com.example.einvoice.billing.RideEnvelope;
import com.example.einvoice.delivery.RideData;
import com.example.einvoice.delivery.RideLayout;
import com.example.einvoice.delivery.RidePdfBuilder;
import com.example.einvoice.notes.CreditNoteContent;
import com.example.einvoice.notes.CreditNoteRide;
import com.example.einvoice.notes.DebitNoteContent;
import com.example.einvoice.notes.DebitNoteRide;
import com.example.einvoice.xml.InvoiceXmlData;
import com.example.einvoice.xml.InvoiceXmlFixtures;

/**
 * RIDE de factura y notas con el código Java: un PDF por caso en {@code ride/} y sus datos de entrada en
 * {@code ride.json}, con los textos y los importes que escribe {@code RideLayout} y las barras de
 * {@code Barcode128}. Los PDF llevan la hora de generación: cambian en cada ejecución, no su contenido.
 */
final class RideCases {

	private static final OffsetDateTime AUTHORIZED_AT = OffsetDateTime.parse("2026-10-07T20:15:30.123456Z");

	private static final String AUTHORIZED_AT_TEXT = "2026-10-07T20:15:30.123456";

	private static final Map<String, String> NAMES = names();

	private RideCases() {
	}

	private static Map<String, String> names() {
		Map<String, String> names = new LinkedHashMap<>();
		names.put("01", "SIN UTILIZACION DEL SISTEMA FINANCIERO");
		names.put("15", "COMPENSACIÓN DE DEUDAS");
		names.put("20", "OTROS CON UTILIZACIÓN DEL SISTEMA FINANCIERO");
		return names;
	}

	static void generate(Path out) throws IOException {
		Path dir = out.resolve("ride");
		Files.createDirectories(dir);
		List<Object> cases = new ArrayList<>();
		for (Map.Entry<String, RideData> invoice : invoices().entrySet()) {
			RideData data = invoice.getValue();
			Files.write(dir.resolve(invoice.getKey() + ".pdf"), RidePdfBuilder.build(data));
			Map<String, Object> entry = new LinkedHashMap<>();
			entry.put("name", invoice.getKey());
			entry.put("type", "01");
			entry.put("authorizationNumber", data.authorizationNumber());
			entry.put("authorizedAt", AUTHORIZED_AT_TEXT);
			entry.put("customerEmail", data.customerEmail());
			entry.put("customerPhone", data.customerPhone());
			entry.put("issuerPhone", data.issuerPhone());
			entry.put("paymentMethodNames", data.paymentMethodNames());
			entry.put("data", DocumentCases.invoiceData(data.invoice()));
			cases.add(entry);
		}
		for (Map.Entry<String, Object[]> note : DocumentCases.creditNotes().entrySet()) {
			DocumentEnvelope envelope = (DocumentEnvelope) note.getValue()[0];
			CreditNoteContent content = (CreditNoteContent) note.getValue()[1];
			Files.write(dir.resolve(note.getKey() + ".pdf"),
					CreditNoteRide.build(new RideEnvelope(envelope, envelope.accessKey(), AUTHORIZED_AT), content));
			note(cases, note.getKey(), "04", envelope, DocumentCases.creditContent(content));
		}
		for (Map.Entry<String, Object[]> note : DocumentCases.debitNotes().entrySet()) {
			DocumentEnvelope envelope = (DocumentEnvelope) note.getValue()[0];
			DebitNoteContent content = (DebitNoteContent) note.getValue()[1];
			Files.write(dir.resolve(note.getKey() + ".pdf"),
					DebitNoteRide.build(new RideEnvelope(envelope, envelope.accessKey(), AUTHORIZED_AT), content, NAMES));
			note(cases, note.getKey(), "05", envelope, DocumentCases.debitContent(content));
		}
		Map<String, Object> root = new LinkedHashMap<>();
		root.put("cases", cases);
		root.put("amounts", amounts());
		root.put("percents", percents());
		root.put("labels", labels());
		root.put("clean", clean());
		root.put("barcodes", barcodes());
		GoldenGenerator.write(out.resolve("ride.json"), root);
	}

	private static void note(List<Object> cases, String name, String type, DocumentEnvelope envelope,
			Map<String, Object> content) {
		Map<String, Object> entry = new LinkedHashMap<>();
		entry.put("name", name);
		entry.put("type", type);
		entry.put("authorizationNumber", envelope.accessKey());
		entry.put("authorizedAt", AUTHORIZED_AT_TEXT);
		entry.put("paymentMethodNames", NAMES);
		entry.put("data", DocumentCases.noteData(envelope, content));
		cases.add(entry);
	}

	// ---------------------------------------------------------------- facturas

	private static Map<String, RideData> invoices() {
		Map<String, RideData> cases = new LinkedHashMap<>();
		cases.put("factura-estandar", ride(InvoiceXmlFixtures.standard()));

		InvoiceXmlFixtures.Builder full = InvoiceXmlFixtures.builder();
		full.specialTaxpayerCode = "5368";
		full.withholdingAgentCode = "1";
		full.rimpeRegime = "EMPRENDEDOR";
		full.accountingRequired = true;
		full.providerRuc = "1790099999001";
		full.payments = List.of(payment("20", "30.00", "30", "dias"), payment("01", "7.00", null, null));
		cases.put("factura-completa", ride(full.build()));

		InvoiceXmlFixtures.Builder popular = InvoiceXmlFixtures.builder();
		popular.rimpeRegime = "NEGOCIO_POPULAR";
		popular.tradeName = null;
		popular.establishmentAddress = "Av. Amazonas N34-12, Quito";
		popular.payments = List.of(payment("20", "30.00", "30.00", "dias"), payment("01", "7.00", "1.50", "meses"));
		cases.put("factura-negocio-popular", ride(popular.build()));

		InvoiceXmlFixtures.Builder bare = InvoiceXmlFixtures.builder();
		bare.establishmentAddress = null;
		bare.customerAddress = null;
		cases.put("factura-sin-opcionales", new RideData(bare.build(), InvoiceXmlFixtures.ACCESS_KEY, AUTHORIZED_AT,
				null, null, null, Map.of()));

		cases.put("factura-otras-tarifas", ride(with(InvoiceXmlFixtures.standard(), "2", "04", "1790012345001",
				List.of(tax("6", "0.00", "10.00", "0.00"), tax("7", "0.00", "20.00", "0.00"),
						tax("8", "8.00", "5.00", "0.40"), tax("10", "13.00", "1.00", "0.13"),
						tax("4", "15.00", "1.00", "0.15"), tax("4", "15.00", "2.00", "0.30"),
						tax("5", "5.00", "3.00", "0.15"), tax("9", "8.5", "3.00", "0.26")),
				"30.00", "1.25", "35.40")));
		cases.put("factura-pasaporte-en-produccion", ride(with(InvoiceXmlFixtures.standard(), "2", "06", "AB123456",
				InvoiceXmlFixtures.standard().taxes(), "34.00", "0.00", "37.00")));
		cases.put("factura-consumidor-final", ride(with(InvoiceXmlFixtures.standard(), "1", "07", "9999999999999",
				InvoiceXmlFixtures.standard().taxes(), "34.00", "0.00", "9999999999.99")));

		InvoiceXmlFixtures.Builder odd = InvoiceXmlFixtures.builder();
		odd.legalName = "Ñandú & Hijos <S.A.> \"Cía.\"";
		odd.tradeName = "Línea\r\nBcc: otra 😀 東京";
		odd.customerAddress = "x".repeat(300);
		odd.lines = List.of(line("A\u0000B", "Café\tcon leche — «especial» €5", "1", "1.00", "1.00"),
				line("a-b-c", "guion-y-mas-guiones-para-que-el-texto-se-parta-en-los-guiones-y-no-en-medio-de-una-palabra",
						"1", "1.00", "1.00"),
				line("2026-10-07", "Periodo 2026-10-07 a 2026-10-08, del 01/10/2026 al 07/10/2026 y 2026-10-07 otra vez",
						"1", "1.00", "1.00"),
				line("CODIGO-MUY-LARGO-DE-VEINTICINCO", "W".repeat(80), "1", "1.00", "1.00"),
				line("x", "espacios    seguidos  y al final   ", "1", "1.00", "1.00"),
				line("x", "palabra con espacios duros que no se parten y­guion­blando‐guion‑duro " + "ab ".repeat(40),
						"1", "1.00", "1.00"),
				line("", "", "1", "1.00", "1.00"));
		cases.put("factura-caracteres-raros", ride(odd.build()));

		cases.put("factura-correo-largo",
				new RideData(InvoiceXmlFixtures.standard(), InvoiceXmlFixtures.ACCESS_KEY, AUTHORIZED_AT,
						"contabilidad.cuentas.por.pagar@grupo-empresarial-andino.com.ec", null, null, NAMES));

		InvoiceXmlFixtures.Builder payments = InvoiceXmlFixtures.builder();
		List<InvoiceXmlData.Payment> twenty = new ArrayList<>();
		for (int i = 1; i <= 20; i++) {
			twenty.add(payment(i % 3 == 0 ? "15" : i % 2 == 0 ? "20" : "01", i + ".00", i % 4 == 0 ? "30" : null,
					i % 4 == 0 ? "dias" : null));
		}
		payments.payments = twenty;
		cases.put("factura-veinte-pagos", ride(payments.build()));

		InvoiceXmlFixtures.Builder names = InvoiceXmlFixtures.builder();
		names.legalName = "Compañía de Importaciones y Exportaciones ".repeat(7).trim();
		names.tradeName = "NOMBRE COMERCIAL EXTRAORDINARIAMENTE LARGO ".repeat(6).trim();
		names.establishmentAddress = "Calle Principal 123 y Transversal, Edificio Norte, piso 4, ".repeat(5).trim();
		names.customerAddress = "Barrio La Floresta, pasaje B, casa 12 ".repeat(7).trim();
		cases.put("factura-nombres-largos", ride(names.build()));

		InvoiceXmlFixtures.Builder decimals = InvoiceXmlFixtures.builder();
		decimals.lines = List.of(line("D-1", "Cantidad con seis decimales", "123456789012.123456", "0.000001", "0.12"),
				line("D-2", "Precio con seis decimales", "1", "999999999999.999999", "999999999999.99"),
				line("D-3", "Cero", "0.000000", "0.000000", "0.00"), line("D-4", "Ceros finales", "10.500000", "1.230000", "12.92"));
		cases.put("factura-decimales", ride(decimals.build()));

		for (int lines : new int[] { 1, 5, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 30, 40, 41, 42, 43, 44, 45, 46, 47, 48, 60,
				300, 500 }) {
			InvoiceXmlFixtures.Builder many = InvoiceXmlFixtures.builder();
			List<InvoiceXmlData.Line> list = new ArrayList<>();
			for (int i = 1; i <= lines; i++) {
				list.add(line("COD-" + i, i % 7 == 0 ? "Producto número " + i + " con una descripción que no cabe en una sola línea de la columna"
						: "Producto número " + i, "1", "1.00", "1.00"));
			}
			many.lines = list;
			cases.put("factura-" + lines + "-lineas", ride(many.build()));
		}
		return cases;
	}

	private static RideData ride(InvoiceXmlData invoice) {
		return new RideData(invoice, InvoiceXmlFixtures.ACCESS_KEY, AUTHORIZED_AT, "cliente@example.test", "0991234567",
				"(02) 245-6789", NAMES);
	}

	private static InvoiceXmlData with(InvoiceXmlData base, String environment, String idType, String idNumber,
			List<InvoiceXmlData.Tax> taxes, String subtotal, String discount, String total) {
		return new InvoiceXmlData(environment, base.issuerLegalName(), base.issuerTradeName(), base.issuerRuc(),
				base.accessKey(), base.documentType(), base.establishmentCode(), base.emissionPointCode(), base.sequence(),
				base.headOfficeAddress(), base.withholdingAgentCode(), base.rimpeRegime(), LocalDate.of(2026, 10, 7),
				base.establishmentAddress(), base.specialTaxpayerCode(), base.accountingRequired(), idType,
				base.customerName(), idNumber, base.customerAddress(), d(subtotal), d(discount), taxes, d(total),
				base.lines(), base.payments(), base.providerRuc());
	}

	private static InvoiceXmlData.Line line(String code, String description, String quantity, String unitPrice,
			String subtotal) {
		return new InvoiceXmlData.Line(code, description, d(quantity), d(unitPrice), d("0.00"), d(subtotal), "2", "4",
				d("15.00"), d("0.15"));
	}

	private static InvoiceXmlData.Tax tax(String rateCode, String rate, String base, String amount) {
		return new InvoiceXmlData.Tax("2", rateCode, d(rate), d(base), d(amount));
	}

	private static InvoiceXmlData.Payment payment(String code, String amount, String term, String unit) {
		return new InvoiceXmlData.Payment(code, d(amount), term == null ? null : d(term), unit);
	}

	private static BigDecimal d(String value) {
		return new BigDecimal(value);
	}

	// ------------------------------------------------------------------- piezas

	private static List<Object> amounts() {
		List<Object> cases = new ArrayList<>();
		for (String value : List.of("0", "0.00", "0.000000", "1", "1.0", "10", "100", "1.5", "1.50", "1.500000", "1.234567",
				"9.333333", "0.1", "0.01", "0.001", "1000000.000000", "123456789012.123456")) {
			for (int scale : new int[] { 0, 2 }) {
				Map<String, Object> entry = new LinkedHashMap<>();
				entry.put("value", value);
				entry.put("minScale", scale);
				entry.put("result", amount(value, scale));
				cases.add(entry);
			}
		}
		return cases;
	}

	private static String amount(String value, int scale) {
		return RideLayout.amount(d(value), scale);
	}

	private static List<Object> percents() {
		List<Object> cases = new ArrayList<>();
		for (String value : List.of("0", "0.00", "5", "5.00", "15.00", "12", "8.5", "8.50", "100.00", "0.25", "20")) {
			Map<String, Object> entry = new LinkedHashMap<>();
			entry.put("value", value);
			entry.put("result", RideLayout.percent(d(value)));
			cases.add(entry);
		}
		return cases;
	}

	private static List<Object> labels() {
		List<Object> cases = new ArrayList<>();
		for (String code : List.of("0", "2", "4", "5", "6", "7", "8", "10")) {
			Map<String, Object> entry = new LinkedHashMap<>();
			entry.put("rateCode", code);
			entry.put("rate", "15.00");
			entry.put("result", RideLayout.rateLabel(code, d("15.00")));
			cases.add(entry);
		}
		return cases;
	}

	private static List<Object> clean() {
		List<Object> cases = new ArrayList<>();
		StringBuilder latin = new StringBuilder();
		for (int c = 0x20; c < 0x180; c++) {
			latin.append((char) c);
		}
		StringBuilder symbols = new StringBuilder("a");
		for (int c = 0x2000; c < 0x2130; c++) {
			symbols.append((char) c);
		}
		for (String value : new String[] { null, "", "  a  ", "a\r\nb\tc\u0000d", "Ñandú €5 — «x» “y” ‘z’ … • ™ Œœ Šš Žž Ÿ ƒ",
				"😀東京", "a b", " a ", "a　b", "a­b", latin.toString(), symbols.toString() }) {
			Map<String, Object> entry = new LinkedHashMap<>();
			entry.put("value", value);
			entry.put("result", RideLayout.clean(value));
			cases.add(entry);
		}
		return cases;
	}

	private static List<Object> barcodes() {
		List<Object> cases = new ArrayList<>();
		for (String code : List.of(InvoiceXmlFixtures.ACCESS_KEY, "0".repeat(49), "9".repeat(49),
				"1210202601179001234500110010010000000011234567813")) {
			Map<String, Object> entry = new LinkedHashMap<>();
			entry.put("code", code);
			// Anchos en módulos de barras y espacios alternos, con la parada.
			byte[] bars = Barcode128.getBarsCode128Raw(Barcode128.getRawText(code, false));
			StringBuilder text = new StringBuilder();
			for (byte bar : bars) {
				text.append(bar);
			}
			entry.put("bars", text.toString());
			cases.add(entry);
		}
		return cases;
	}

}
