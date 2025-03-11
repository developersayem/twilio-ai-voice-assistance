import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const SYSTEM_MESSAGE = 'You are a helpful AI assistant.';
const VOICE = 'alloy';
const PORT = process.env.PORT || 5050;

// Twilio XML response
fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>Connecting you to the AI assistant.</Say>
                              <Pause length="1"/>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;
    reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Twilio client connected');

        let streamSid = null;
        let latestMediaTimestamp = 0;
        let openAiWs = createOpenAIWebSocket();
        let keepAliveInterval = null;

        function createOpenAIWebSocket() {
            const ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    "OpenAI-Beta": "realtime=v1"
                }
            });

            ws.on('open', () => {
                console.log('Connected to OpenAI Realtime API');
                ws.send(JSON.stringify({
                    type: 'session.update',
                    session: {
                        turn_detection: { type: 'server_vad' },
                        input_audio_format: 'g711_ulaw',
                        output_audio_format: 'g711_ulaw',
                        voice: VOICE,
                        instructions: SYSTEM_MESSAGE,
                        modalities: ["text", "audio"],
                        temperature: 0.8,
                    }
                }));
            });

            ws.on('close', () => {
                console.warn('OpenAI WebSocket closed. Reconnecting...');
                setTimeout(() => { openAiWs = createOpenAIWebSocket(); }, 3000);
            });

            ws.on('error', (error) => {
                console.error('OpenAI WebSocket error:', error);
            });

            ws.on('message', (data) => {
                try {
                    const response = JSON.parse(data);
                    if (response.type === 'response.audio.delta' && response.delta) {
                        const audioDelta = {
                            event: 'media',
                            streamSid: streamSid,
                            media: { payload: response.delta }
                        };
                        connection.send(JSON.stringify(audioDelta));
                    }
                } catch (error) {
                    console.error('Error processing OpenAI message:', error, 'Raw message:', data);
                }
            });

            return ws;
        }

        function sendSilencePackets() {
            if (connection.readyState === WebSocket.OPEN) {
                const silencePacket = {
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: 'UklGRgA=' } // Encoded silence in G.711 µ-law
                };
                connection.send(JSON.stringify(silencePacket));
            }
        }

        keepAliveInterval = setInterval(() => {
            sendSilencePackets(); // Keeps Twilio connection alive
            connection.ping(); // Sends a heartbeat to Twilio WebSocket
        }, 5000);

        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            openAiWs.send(JSON.stringify({
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            }));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Stream started:', streamSid);
                        break;
                    case 'stop':
                        console.log('Twilio stream ended.');
                        clearInterval(keepAliveInterval);
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            openAiWs.close();
                        }
                        break;
                    default:
                        console.log('Received unknown event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        connection.on('close', () => {
            console.warn('Twilio connection closed.');
            clearInterval(keepAliveInterval);
            if (openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.close();
            }
        });
    });
});

// Start server
fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});
