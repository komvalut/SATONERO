git clone https://github.com/tvoj-username/satonero
cd satonero
npm install
cp .env.example .env
# popuni .env sa tvojim DATABASE_URL
psql -d tvoja_baza -f schema.sql
npm start