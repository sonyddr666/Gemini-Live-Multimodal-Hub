import { Type, FunctionDeclaration } from '@google/genai';

export const modularTools: FunctionDeclaration[] = [
  {
    name: 'search_web',
    description: 'Search the web for real-time information, news, or facts.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'The search query.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'schedule_meeting',
    description: 'Schedule a meeting or event in the calendar.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: 'Title of the meeting.' },
        attendees: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'List of attendee emails or names.' },
        date: { type: Type.STRING, description: 'Date of the meeting (YYYY-MM-DD).' },
        time: { type: Type.STRING, description: 'Time of the meeting (HH:MM).' },
      },
      required: ['title', 'attendees', 'date', 'time'],
    },
  },
  {
    name: 'control_smart_home',
    description: 'Control smart home devices like lights, thermostat, locks, etc.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        device: { type: Type.STRING, description: 'The device to control.' },
        action: { type: Type.STRING, description: 'The action to perform (e.g., turn on, set temperature to 72).' },
        room: { type: Type.STRING, description: 'The room where the device is located.' },
      },
      required: ['device', 'action'],
    },
  },
  {
    name: 'generate_image',
    description: 'Generate an image based on a text prompt.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: { type: Type.STRING, description: 'Detailed description of the image to generate.' },
        style: { type: Type.STRING, description: 'The artistic style (e.g., photorealistic, cartoon, oil painting).' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'analyze_data',
    description: 'Perform complex data analysis or calculations.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        dataset: { type: Type.STRING, description: 'The data to analyze (JSON or CSV format).' },
        operation: { type: Type.STRING, description: 'The operation to perform (e.g., average, sum, correlation).' },
      },
      required: ['dataset', 'operation'],
    },
  },
  {
    name: 'translate_text',
    description: 'Translate text from one language to another.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: { type: Type.STRING, description: 'The text to translate.' },
        target_language: { type: Type.STRING, description: 'The language to translate to.' },
      },
      required: ['text', 'target_language'],
    },
  },
  {
    name: 'get_weather',
    description: 'Get the current weather and forecast for a location.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        location: { type: Type.STRING, description: 'The city and state, e.g., San Francisco, CA' },
        units: { type: Type.STRING, description: 'Units for temperature (celsius or fahrenheit)' },
      },
      required: ['location'],
    },
  },
  {
    name: 'execute_code',
    description: 'Execute Python or JavaScript code in a secure sandbox.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        language: { type: Type.STRING, description: 'The programming language (python or javascript)' },
        code: { type: Type.STRING, description: 'The code to execute' },
      },
      required: ['language', 'code'],
    },
  },
  {
    name: 'manage_email',
    description: 'Read, send, or organize emails.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: { type: Type.STRING, description: 'The action (read, send, delete, archive)' },
        recipient: { type: Type.STRING, description: 'Email address of the recipient (if sending)' },
        subject: { type: Type.STRING, description: 'Subject of the email' },
        body: { type: Type.STRING, description: 'Body content of the email' },
      },
      required: ['action'],
    },
  },
  {
    name: 'fetch_page',
    description: 'Reads the content of a URL and returns the text.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: 'The URL of the page to fetch.' },
        maxChars: { type: Type.NUMBER, description: 'Maximum number of characters to return.' },
      },
      required: ['url'],
    },
  }
];

export async function handleToolCall(name: string, args: any): Promise<any> {
  console.log(`Executing tool: ${name}`, args);
  
  // Simulate tool execution with mock responses
  switch (name) {
    case 'fetch_page':
      try {
        const res = await fetch(args.url);
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('script,style,noscript,template,svg').forEach(n => n.remove());
        const text = (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
        const maxChars = args.maxChars || 12000;
        return {
          ok: true,
          title: doc.title || '',
          contentPreview: text.slice(0, maxChars),
          truncated: text.length > maxChars
        };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    case 'search_web':
      return { result: `Found 3 results for "${args.query}". 1. Example article. 2. Wikipedia page. 3. News report.` };
    case 'schedule_meeting':
      return { status: 'success', message: `Meeting "${args.title}" scheduled for ${args.date} at ${args.time} with ${args.attendees.join(', ')}.` };
    case 'control_smart_home':
      return { status: 'success', message: `Device ${args.device} in ${args.room || 'unknown room'} set to: ${args.action}.` };
    case 'generate_image':
      return { status: 'success', url: `https://picsum.photos/seed/${encodeURIComponent(args.prompt)}/800/600`, message: `Generated image with style ${args.style || 'default'}.` };
    case 'analyze_data':
      return { status: 'success', result: `Analysis complete. Operation ${args.operation} returned a value of 42.` };
    case 'translate_text':
      return { status: 'success', translated_text: `[Translated to ${args.target_language}]: ${args.text}` };
    case 'get_weather':
      return { status: 'success', temperature: args.units === 'celsius' ? '22Â°C' : '72Â°F', condition: 'Sunny with light breeze' };
    case 'execute_code':
      return { status: 'success', output: `Execution of ${args.language} code completed successfully. Output: Hello World!` };
    case 'manage_email':
      if (args.action === 'send') {
        return { status: 'success', message: `Email sent to ${args.recipient} with subject "${args.subject}".` };
      }
      return { status: 'success', message: `Performed ${args.action} on emails.` };
    default:
      return { status: 'error', message: `Tool ${name} not implemented.` };
  }
}
