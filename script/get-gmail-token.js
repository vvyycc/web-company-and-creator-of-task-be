require('dotenv').config(); 
const { google } = require('googleapis');
const readline = require('readline');

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost';

const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

const SCOPES = ['https://www.googleapis.com/auth/gmail.send'];

function getAccessToken() {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\nVisita esta URL en tu navegador:\n', authUrl);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question('\nPega aquí el "code" de Google: ', async (code) => {
    rl.close();
    try {
      const { tokens } = await oAuth2Client.getToken(code.trim());
      console.log('\n=== TOKENS OBTENIDOS ===\n');
      console.log(JSON.stringify(tokens, null, 2));
      console.log('\nGuarda el refresh_token en .env como GMAIL_REFRESH_TOKEN');
    } catch (err) {
      console.error('Error al obtener token:', err);
    }
  });
}

getAccessToken();
