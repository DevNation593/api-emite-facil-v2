package golden;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.math.BigDecimal;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.JavaMailSenderImpl;

import com.example.einvoice.billing.DocumentEnvelope;
import com.example.einvoice.billing.RideEnvelope;
import com.example.einvoice.delivery.AuthorizedXmlBuilder;
import com.example.einvoice.delivery.DeliveryEmail;
import com.example.einvoice.delivery.DeliveryEmailFactory;
import com.example.einvoice.delivery.DeliveryMailer;
import com.example.einvoice.delivery.DeliveryProperties;
import com.example.einvoice.delivery.SmtpDeliveryMailer;
import com.example.einvoice.sri.SriEnvironment;
import com.example.einvoice.xml.DocumentType;
import com.example.einvoice.xml.InvoiceXmlFixtures;

/**
 * Lo que la entrega escribe o decide sin base de datos: las direcciones que {@code DeliveryProperties} admite, el
 * texto de cabecera ({@code DeliveryEmailFactory.headerSafe}, por reflexión), el correo redactado, el XML
 * autorizado y cómo clasifica {@code SmtpDeliveryMailer} cada fallo de un servidor SMTP de guion. Es determinista.
 */
final class DeliveryCases {

	private static final String KEY = InvoiceXmlFixtures.ACCESS_KEY;

	private DeliveryCases() {
	}

	static Map<String, Object> generate() throws Exception {
		Map<String, Object> json = new LinkedHashMap<>();
		json.put("addresses", addresses());
		json.put("headers", headers());
		json.put("emails", emails());
		json.put("authorizedXml", authorizedXml());
		json.put("mailer", mailer());
		return json;
	}

	// ------------------------------------------------------------- direcciones

	private static List<Object> addresses() {
		List<String> values = new ArrayList<>(List.of("ana.perez+facturas@mi-empresa.com.ec", "a@b", "a@localhost",
				"a@b.test", "A@B.TEST", "a@b.c.d.e", "1@2", "a-b_c@d-e.test", "a!#$%&'*+-/=?^_`{|}~b@c.test", "a..b@c.test",
				".a@b.test", "a.@b.test", "a@.b.test", "a@b..test", "a@b.test.", "a@b-", "a@-b", "a@b_c.test", "a@b!c.test",
				"a@", "@b.test", "a", "", " ", "@", "@@", "a@b@c.test", "a@@b.test", "@a@b.test", "@a,@b:c@d.test",
				"@a:b@c.test", "a@[127.0.0.1]", "a@[IPv6:::1]", "a@[]", "a@[b", "a@b]", "a@[b]c", "a@c[b]", "a@[a b]",
				"a[b@c.test", "a]b@c.test", "a\\b@c.test", "a\\@b.test", "a\\@b@c.test", "\\@b.test", "a\\", "a\\@", "a@b\\c",
				"a/b@c.test", "a=b@c.test", "ñandú@empresa.test", "a@ñandú.test", "a@empresa.ñ", "a@東京.test", "東京@a.test",
				"a@😀.test", "😀@a.test", "a@٣.test", "a@Ⅷ.test", "a@²", "a@ª.test", "a b@c.test", "a@b c.test",
				"a\u0085b@c.test", "a@b\u0085", "a​b@c.test", "a@b​c.test", "a b@c.test", "a　b@c.test",
				"a b@c.test", " a@b.test", "a@b.test ", "a\t@b.test", "a@b.test\n", "a@b.test\r\nBcc: x@evil.test",
				"a\u0000@b.test", "a\u007f@b.test", "a@b\u007f.test", "a,b@c.test", "a@b.test,c@d.test", "a@b.test;c@d.test",
				"grupo:a@x.test,b@y.test;", "grupo:a@x.test;", "a:b@c.test", "<a@x.test>", "a<b@c.test", "a>b@c.test",
				"\"Ana\" <a@x.test>", "\"a b\"@c.test", "a@x.test (Ana)", "a(b)@c.test", "Ana <a@x.test>",
				"no-es-un-correo", "a@x.test b@y.test", "a%b@c.test", "a%b@c", "a!b@c", "mailto&a@b.test", "'a'@b.test",
				"a@b.test'", "a`b@c.test", "a{b}@c.test", "a@1.2.3.4", "a@b.test:25", "a@b/c", "a@b?c", "a@b#c", "a~@b.test",
				"=?UTF-8?Q?a?=@b.test", "a@=?UTF-8?Q?b?=", "a@xn--andu-hqa.test", "a@b--c.test", "­x@b.test", "x@b­.test",
				"x@á.test", "á@b.test"));
		values.add("x".repeat(247) + "@b.test");
		values.add("x".repeat(248) + "@b.test");
		values.add("a@" + "b".repeat(252));
		values.add("a@" + "b".repeat(253));
		List<Object> cases = new ArrayList<>();
		for (String value : values) {
			Map<String, Object> entry = new LinkedHashMap<>();
			entry.put("address", value);
			entry.put("valid", DeliveryProperties.validAddress(value));
			cases.add(entry);
		}
		Map<String, Object> none = new LinkedHashMap<>();
		none.put("address", null);
		none.put("valid", DeliveryProperties.validAddress(null));
		cases.add(none);
		return cases;
	}

	// --------------------------------------------------------------- cabeceras

	private static List<Object> headers() throws Exception {
		Method method = DeliveryEmailFactory.class.getDeclaredMethod("headerSafe", String.class, int.class);
		method.setAccessible(true);
		List<Object> cases = new ArrayList<>();
		Object[][] inputs = { { null, 10 }, { "", 10 }, { "Andina", 10 }, { "  Andina  ", 10 },
				{ "Andina\r\nBcc: x@evil.test", 120 }, { "a\u0000b", 10 }, { "a\u007fb\u0085c\u009fd", 20 },
				{ "a b", 10 }, { "a b c", 10 }, { "a b c", 10 }, { "a　b c​d", 20 },
				{ "a \t \n b", 10 }, { "\t\n a", 10 }, { "a \t\n", 10 }, { "a  b", 10 }, { " \u0000 ", 10 },
				{ " a ", 10 }, { "x".repeat(400), 120 }, { "abcdefghi jkl", 10 }, { "abcdefghij klm", 11 },
				{ "😀😀😀", 4 }, { "a😀b", 10 }, { "東京 Ñandú", 10 }, { "\u001ca\u001fb", 10 }, { "‎‮a", 10 },
				{ "a" + " b".repeat(80), 120 } };
		for (Object[] input : inputs) {
			Map<String, Object> entry = new LinkedHashMap<>();
			entry.put("value", input[0]);
			entry.put("max", input[1]);
			entry.put("result", method.invoke(null, input[0], input[1]));
			cases.add(entry);
		}
		return cases;
	}

	// ------------------------------------------------------------------ correo

	private static RideEnvelope ride(DocumentType type, String legalName, String tradeName, String recipient,
			String total) {
		DocumentEnvelope envelope = new DocumentEnvelope(type, "1",
				new DocumentEnvelope.Issuer(legalName, tradeName, "1790012345001", "Quito", "Quito", false, null, null,
						"NONE", null),
				KEY, "001", "002", 123, LocalDate.of(2026, 1, 7),
				new DocumentEnvelope.Recipient("05", "1712345678", recipient, "Quito", "cliente@example.test", null),
				total == null ? null
						: new DocumentEnvelope.Totals(new BigDecimal("33.00"), BigDecimal.ZERO, new BigDecimal("4.00"),
								new BigDecimal(total)),
				null, "1790099999001");
		return new RideEnvelope(envelope, KEY, OffsetDateTime.parse("2026-01-07T20:15:30Z"));
	}

	private static List<Object> emails() {
		List<Object> cases = new ArrayList<>();
		emails(cases, "factura", "Factura", ride(DocumentType.INVOICE, "Comercial Andina S.A.", "Andina", "María Pérez", "37.00"));
		emails(cases, "factura", "Factura", ride(DocumentType.INVOICE, "Comercial Andina S.A.", null, "María Pérez", "37.00"));
		emails(cases, "factura", "Factura", ride(DocumentType.INVOICE, "Comercial Andina S.A.", " \n ", "María Pérez", "0.00"));
		emails(cases, "factura", "Factura",
				ride(DocumentType.INVOICE, "Ñandú & Hijos\r\nBcc: x@evil.test", "Andina\r\nBcc: x@evil.test\u0000" + "x".repeat(400),
						"Juan\r\nBcc: y@evil.test 😀", "1234567890.50"));
		emails(cases, "nota-credito", "Nota de crédito",
				ride(DocumentType.CREDIT_NOTE, "Comercial Andina S.A.", "Andina", "María Pérez", "37.00"));
		emails(cases, "nota-debito", "Nota de débito",
				ride(DocumentType.DEBIT_NOTE, "Comercial Andina S.A.", "Andina", "María Pérez", "16.50"));
		emails(cases, "guia-remision", "Guía de remisión",
				ride(DocumentType.INVOICE, "Comercial Andina S.A.", "Andina", "María Pérez", null));
		emails(cases, "factura", "Factura",
				ride(DocumentType.INVOICE, "N".repeat(300), "T".repeat(300), "C".repeat(300), "37.00"));
		return cases;
	}

	private static void emails(List<Object> cases, String fileStem, String displayName, RideEnvelope ride) {
		DeliveryEmail email = DeliveryEmailFactory.build("facturas@plataforma.test", ride, displayName, fileStem,
				"cliente@example.test", "pdf".getBytes(StandardCharsets.UTF_8), "xml".getBytes(StandardCharsets.UTF_8));
		Map<String, Object> entry = new LinkedHashMap<>();
		entry.put("fileStem", fileStem);
		entry.put("displayName", displayName);
		entry.put("type", ride.envelope().type().code());
		entry.put("legalName", ride.envelope().issuer().legalName());
		entry.put("tradeName", ride.envelope().issuer().tradeName());
		entry.put("recipientName", ride.envelope().recipient().name());
		entry.put("total", ride.envelope().totals() == null ? null : ride.envelope().totals().total().toPlainString());
		Map<String, Object> result = new LinkedHashMap<>();
		result.put("from", email.from());
		result.put("fromName", email.fromName());
		result.put("to", email.to());
		result.put("subject", email.subject());
		result.put("text", email.text());
		List<Object> attachments = new ArrayList<>();
		for (DeliveryEmail.Attachment attachment : email.attachments()) {
			Map<String, Object> a = new LinkedHashMap<>();
			a.put("filename", attachment.filename());
			a.put("contentType", attachment.contentType());
			a.put("content", new String(attachment.content(), StandardCharsets.UTF_8));
			attachments.add(a);
		}
		result.put("attachments", attachments);
		entry.put("email", result);
		cases.add(entry);
	}

	// ---------------------------------------------------------- XML autorizado

	private static List<Object> authorizedXml() {
		byte[] signed = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><factura id=\"comprobante\">Ñandú &amp; Cía. 😀</factura>"
			.getBytes(StandardCharsets.UTF_8);
		List<Object> cases = new ArrayList<>();
		// Instantes en UTC con microsegundos, como los guarda PostgreSQL.
		for (String instant : List.of("2026-10-12T14:30:00.000000Z", "2012-03-05T21:57:34.997000Z",
				"2012-03-05T21:57:34.123456Z", "2012-03-05T21:57:34.500000Z", "2012-03-05T21:57:34.000001Z",
				"2026-01-01T03:00:00.100000Z", "2026-03-01T04:59:59.999999Z", "2024-03-01T00:00:00.000000Z",
				"9999-12-31T23:59:59.000000Z", "0001-01-01T05:00:00.000000Z")) {
			authorizedXml(cases, KEY, instant, SriEnvironment.TEST, signed);
		}
		authorizedXml(cases, KEY, "2026-10-12T14:30:00.000000Z", SriEnvironment.PRODUCTION, signed);
		for (String number : new String[] { null, "", " ", "123456789", "1234567890", "1".repeat(49), "1".repeat(50),
				"12<3456789012", "١".repeat(10) }) {
			authorizedXml(cases, number, "2026-10-12T14:30:00.000000Z", SriEnvironment.TEST, signed);
		}
		authorizedXml(cases, KEY, null, SriEnvironment.TEST, signed);
		authorizedXml(cases, KEY, "2026-10-12T14:30:00.000000Z", SriEnvironment.TEST, null);
		authorizedXml(cases, KEY, "2026-10-12T14:30:00.000000Z", SriEnvironment.TEST, new byte[0]);
		for (String content : List.of("a ]]> b", "]]>", "]]]]>>", "]]>]]>", "﻿<a/>", "<a>\r\n\t</a>\n", "\u0000")) {
			authorizedXml(cases, KEY, "2026-10-12T14:30:00.000000Z", SriEnvironment.TEST,
					content.getBytes(StandardCharsets.UTF_8));
		}
		authorizedXml(cases, KEY, "2026-10-12T14:30:00.000000Z", SriEnvironment.TEST,
				new byte[] { '<', (byte) 0xC3, (byte) 0x28, (byte) 0xFF, (byte) 0xED, (byte) 0xA0, (byte) 0x80, '>' });
		return cases;
	}

	private static void authorizedXml(List<Object> cases, String number, String instant, SriEnvironment environment,
			byte[] signed) {
		Map<String, Object> entry = new LinkedHashMap<>();
		entry.put("authorizationNumber", number);
		entry.put("authorizedAt", instant == null ? null : instant.substring(0, instant.length() - 1));
		entry.put("environment", environment.name());
		entry.put("signed", signed == null ? null : base64(signed));
		try {
			entry.put("xml", base64(AuthorizedXmlBuilder.build(number,
					instant == null ? null : OffsetDateTime.parse(instant), environment, signed)));
			entry.put("error", null);
		}
		catch (IllegalArgumentException ex) {
			entry.put("xml", null);
			entry.put("error", ex.getMessage());
		}
		cases.add(entry);
	}

	private static String base64(byte[] bytes) {
		return Base64.getEncoder().encodeToString(bytes);
	}

	// -------------------------------------------------------------------- SMTP

	private static List<Object> mailer() throws Exception {
		List<Object> cases = new ArrayList<>();
		String to = "cliente@example.test";
		mailer(cases, "acepta", to, Map.of());
		for (int code : new int[] { 421, 450, 451, 452, 500, 501, 550, 552, 554 }) {
			mailer(cases, "rcpt " + code, to, Map.of("RCPT", code + " 5.1.1 respuesta de prueba"));
			mailer(cases, "mail " + code, to, Map.of("MAIL", code + " 5.1.1 respuesta de prueba"));
			mailer(cases, "data " + code, to, Map.of("DATA", code + " 5.1.1 respuesta de prueba"));
			mailer(cases, "fin " + code, to, Map.of("END", code + " 5.1.1 respuesta de prueba"));
		}
		mailer(cases, "rcpt 251", to, Map.of("RCPT", "251 se reenviará"));
		mailer(cases, "rcpt 252", to, Map.of("RCPT", "252 no se puede verificar"));
		mailer(cases, "rcpt 350", to, Map.of("RCPT", "350 raro"));
		mailer(cases, "fin 251", to, Map.of("END", "251 raro"));
		mailer(cases, "fin sin texto", to, Map.of("END", "554"));
		mailer(cases, "fin varias líneas", to, Map.of("END", "554-primera línea\r\n554-segunda línea\r\n554 tercera"));
		mailer(cases, "rcpt varias líneas", to, Map.of("RCPT", "550-primera línea\r\n550 segunda"));
		mailer(cases, "fin 400 letras", to, Map.of("END", "554 " + "x".repeat(400)));
		mailer(cases, "fin con tildes", to, Map.of("END", "550 5.1.1 El buzón no existe"));
		mailer(cases, "saludo 421", to, Map.of("GREETING", "421 ocupado"));
		mailer(cases, "saludo 554", to, Map.of("GREETING", "554 no se atiende"));
		mailer(cases, "ehlo 502", to, Map.of("EHLO", "502 no implementado"));
		mailer(cases, "ehlo y helo 554", to, Map.of("EHLO", "554 no", "HELO", "554 no"));
		mailer(cases, "corte en el saludo", to, Map.of("GREETING", "DROP"));
		mailer(cases, "corte en mail", to, Map.of("MAIL", "DROP"));
		mailer(cases, "corte en rcpt", to, Map.of("RCPT", "DROP"));
		mailer(cases, "corte en data", to, Map.of("DATA", "DROP"));
		mailer(cases, "corte al final", to, Map.of("END", "DROP"));
		mailer(cases, "sin respuesta en el saludo", to, Map.of("GREETING", "HANG"));
		mailer(cases, "sin respuesta en rcpt", to, Map.of("RCPT", "HANG"));
		mailer(cases, "sin respuesta al final", to, Map.of("END", "HANG"));
		mailer(cases, "puerto cerrado", to, Map.of("OPTION", "CLOSED"));
		mailer(cases, "servidor inexistente", to, Map.of("OPTION", "UNKNOWN_HOST"));
		mailer(cases, "STARTTLS exigido y no ofrecido", to, Map.of("OPTION", "STARTTLS"));
		mailer(cases, "STARTTLS ofrecido y rechazado", to,
				Map.of("OPTION", "STARTTLS", "EHLO", "250-smtp.stub\r\n250 STARTTLS", "STARTTLS", "454 no disponible"));
		mailer(cases, "credenciales rechazadas 535", to,
				Map.of("OPTION", "AUTH", "EHLO", "250-smtp.stub\r\n250 AUTH PLAIN LOGIN", "AUTH", "535 5.7.8 no"));
		mailer(cases, "credenciales rechazadas 454", to,
				Map.of("OPTION", "AUTH", "EHLO", "250-smtp.stub\r\n250 AUTH PLAIN LOGIN", "AUTH", "454 4.7.0 luego"));
		mailer(cases, "credenciales sin AUTH ofrecido", to, Map.of("OPTION", "AUTH"));
		mailer(cases, "dirección en grupo", "grupo:a@x.test,b@y.test;", Map.of());
		mailer(cases, "dirección sin arroba", "no-es-un-correo", Map.of());
		return cases;
	}

	private static void mailer(List<Object> cases, String name, String to, Map<String, String> script) throws Exception {
		Map<String, Object> entry = new LinkedHashMap<>();
		entry.put("name", name);
		entry.put("to", to);
		entry.put("script", new java.util.TreeMap<>(script));
		try (CannedSmtp server = new CannedSmtp(script)) {
			String option = script.getOrDefault("OPTION", "");
			JavaMailSenderImpl sender = new JavaMailSenderImpl();
			sender.setHost(option.equals("UNKNOWN_HOST") ? "no-existe.invalid" : "127.0.0.1");
			int port = server.port();
			if (option.equals("CLOSED")) {
				server.close();
			}
			sender.setPort(port);
			if (option.equals("AUTH")) {
				sender.setUsername("usuario");
				sender.setPassword("clave");
			}
			String startTls = String.valueOf(option.equals("STARTTLS"));
			sender.getJavaMailProperties().setProperty("mail.smtp.starttls.enable", startTls);
			sender.getJavaMailProperties().setProperty("mail.smtp.starttls.required", startTls);
			sender.getJavaMailProperties().setProperty("mail.smtp.connectiontimeout", "2000");
			sender.getJavaMailProperties().setProperty("mail.smtp.timeout", "1000");
			sender.getJavaMailProperties().setProperty("mail.smtp.writetimeout", "1000");
			sender.getJavaMailProperties().setProperty("mail.smtp.localhost", "localhost");
			sender.getJavaMailProperties().setProperty("mail.from", "facturas@plataforma.test");
			StaticListableBeanFactory beans = new StaticListableBeanFactory(Map.of("mailSender", sender));
			DeliveryMailer.Result result = new SmtpDeliveryMailer(beans.getBeanProvider(JavaMailSender.class))
				.send(new DeliveryEmail("facturas@plataforma.test", "Andina", to, "Factura 1", "Hola",
						List.of(new DeliveryEmail.Attachment("a.pdf", "application/pdf",
								"pdf".getBytes(StandardCharsets.UTF_8)))));
			Map<String, Object> json = new LinkedHashMap<>();
			json.put("sent", result.sent());
			json.put("permanent", result.permanent());
			json.put("error", result.error());
			json.put("hasMessageId", result.messageId() != null);
			entry.put("result", json);
		}
		cases.add(entry);
	}

	/**
	 * Servidor SMTP de guion: responde lo que diga el guion a cada orden (GREETING, EHLO, HELO, STARTTLS, AUTH, MAIL,
	 * RCPT, DATA y END, el punto final), corta la conexión con DROP o no responde con HANG.
	 */
	private static final class CannedSmtp implements AutoCloseable {

		private static final Map<String, String> DEFAULTS = Map.of("GREETING", "220 smtp.stub ESMTP", "EHLO",
				"250 smtp.stub", "HELO", "250 smtp.stub", "MAIL", "250 OK", "RCPT", "250 OK", "DATA", "354 Adelante",
				"END", "250 OK en cola");

		private final ServerSocket server;

		private final Map<String, String> script;

		CannedSmtp(Map<String, String> script) throws IOException {
			this.script = script;
			server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"));
			Thread thread = new Thread(() -> {
				while (!server.isClosed()) {
					try (Socket socket = server.accept()) {
						serve(socket);
					}
					catch (IOException | InterruptedException ex) {
						// El cliente se fue o el servidor se cerró.
					}
				}
			});
			thread.setDaemon(true);
			thread.start();
		}

		int port() {
			return server.getLocalPort();
		}

		private void serve(Socket socket) throws IOException, InterruptedException {
			BufferedReader in = new BufferedReader(
					new InputStreamReader(socket.getInputStream(), StandardCharsets.ISO_8859_1));
			OutputStream out = socket.getOutputStream();
			if (!answer(out, "GREETING")) {
				return;
			}
			String line;
			while ((line = in.readLine()) != null) {
				String command = line.toUpperCase(Locale.ROOT);
				if (command.startsWith("QUIT")) {
					out.write("221 Adios\r\n".getBytes(StandardCharsets.ISO_8859_1));
					return;
				}
				if (command.startsWith("RSET") || command.startsWith("NOOP")) {
					out.write("250 OK\r\n".getBytes(StandardCharsets.ISO_8859_1));
					continue;
				}
				String key = List.of("EHLO", "HELO", "STARTTLS", "AUTH", "MAIL", "RCPT", "DATA")
					.stream()
					.filter(command::startsWith)
					.findFirst()
					.orElse("");
				if (!answer(out, key)) {
					return;
				}
				if (key.equals("DATA") && reply(key).startsWith("354")) {
					String data;
					while ((data = in.readLine()) != null && !data.equals(".")) {
						// El mensaje no importa aquí.
					}
					if (!answer(out, "END")) {
						return;
					}
				}
			}
		}

		private String reply(String key) {
			return script.getOrDefault(key, DEFAULTS.getOrDefault(key, "500 Orden desconocida"));
		}

		private boolean answer(OutputStream out, String key) throws IOException, InterruptedException {
			String reply = reply(key);
			if (reply.equals("DROP")) {
				return false;
			}
			if (reply.equals("HANG")) {
				Thread.sleep(2500);
				return false;
			}
			out.write((reply + "\r\n").getBytes(StandardCharsets.UTF_8));
			out.flush();
			return true;
		}

		@Override
		public void close() throws IOException {
			server.close();
		}

	}

}
