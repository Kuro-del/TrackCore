require('dotenv').config({ override: true });

const nodemailer = require('nodemailer');

async function main() {
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();

  console.log('SMTP_USER:', user);
  console.log('SMTP_PASS length:', pass.length);

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user,
      pass
    },
    logger: true,
    debug: true
  });

  await transporter.verify();

  console.log('SMTP conectado correctamente.');

  await transporter.sendMail({
    from: `"TrackCore" <${user}>`,
    to: user,
    subject: 'Prueba TrackCore',
    text: 'Correo de prueba enviado desde TrackCore.'
  });

  console.log('Correo enviado correctamente.');
}

main().catch(error => {
  console.error('ERROR SMTP:', error);
});