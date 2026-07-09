export async function onRequestPost(context) {
  const { request, env } = context;

  // Supabase credentials
  const supabaseUrl = env.SUPABASE_URL || 'https://nhmvgsrwhjsjnpncpiaj.supabase.co';
  const supabaseKey = env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5obXZnc3J3aGpzam5wbmNwaWFqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc5OTY0NjQsImV4cCI6MjA4MzU3MjQ2NH0.qpG5CJDNa53BB7ZpDy414GL3hmb51omxqPrnrrd7O6I';

  // ViteUnDevis credentials
  const vudApiKey = env.VITE_UN_DEVIS_API_KEY || '17695301406978e31c715766978e31c715ae';
  const vudCategory = '144';
  const domain = 'monte-escalier-vaucluse.fr';

  try {
    // Parse form body
    const formData = await request.formData();
    const civility = formData.get('civility') || 'Mme';
    const firstname = formData.get('firstname') || '';
    const lastname = formData.get('lastname') || '';
    const email = formData.get('email') || '';
    const phone = (formData.get('phone') || '').replace(/\s+/g, '');
    const zipcode = formData.get('zipcode') || '';
    const city = formData.get('city') || '';
    const stair_type = formData.get('stair_type') || '';
    const timeline = formData.get('timeline') || '';

    // 1. Validation (must be department 84)
    if (!/^84\d{3}$/.test(zipcode)) {
      return new Response(JSON.stringify({ error: "Code postal invalide pour le Vaucluse (84)" }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!phone || !/^(0|\+33)[1-9]([-. ]?[0-9]{2}){4}$/.test(phone)) {
      return new Response(JSON.stringify({ error: "Numéro de téléphone invalide" }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2. Insert into Supabase
    let supabaseLeadId = null;
    try {
      const supabaseResponse = await fetch(`${supabaseUrl}/rest/v1/rank_rent_leads`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          brand_domain: domain,
          civility,
          firstname,
          lastname,
          email,
          phone,
          zipcode,
          city,
          stair_type,
          timeline,
          status: 'pending',
          created_at: new Date().toISOString()
        })
      });

      if (supabaseResponse.ok) {
        const data = await supabaseResponse.json();
        if (data && data[0]) {
          supabaseLeadId = data[0].id;
        }
      } else {
        const errText = await supabaseResponse.text();
        console.error('Supabase error response:', errText);
      }
    } catch (sbErr) {
      console.error('Supabase write failure:', sbErr);
    }

    // 3. Post to ViteUnDevis
    let vudStatus = 'failed';
    let vudLeadId = null;
    let vudRawResponse = '';

    try {
      const stairLabels = {
        droit: 'Droit',
        tournant: 'Tournant',
        exterieur: 'Extérieur',
        fauteuil_pmr: 'Plateforme PMR'
      };
      const timelineLabels = {
        urgent: "Moins d'un mois (Urgent)",
        '1_to_3_months': 'Sous 1 à 3 mois',
        plus_3_months: 'Plus de 3 mois',
        information: 'Simple information'
      };

      const description = `Monte-escalier : ${stairLabels[stair_type] || stair_type}. Délai : ${timelineLabels[timeline] || timeline}. Demande qualifiée monte-escalier-vaucluse.fr.`;

      // Construct form body parameters
      const params = new URLSearchParams();
      params.append('key', vudApiKey);
      params.append('category', vudCategory);
      params.append('civility', civility);
      params.append('firstname', firstname);
      params.append('lastname', lastname);
      params.append('email', email);
      params.append('phone', phone);
      params.append('zipcode', zipcode);
      params.append('city', city);
      params.append('description', description);
      params.append('domain', domain);

      const vudResponse = await fetch('https://www.viteundevis.com/api/lead', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      });

      vudRawResponse = await vudResponse.text();

      if (vudResponse.ok) {
        try {
          const vudData = JSON.parse(vudRawResponse);
          if (vudData.success || vudData.status === 'success' || vudData.id) {
            vudStatus = 'sent';
            vudLeadId = vudData.id || null;
          }
        } catch (e) {
          // If response is not JSON but OK
          if (vudRawResponse.toLowerCase().includes('success') || vudRawResponse.toLowerCase().includes('ok')) {
            vudStatus = 'sent';
          }
        }
      }
    } catch (vudErr) {
      console.error('ViteUnDevis API post failure:', vudErr);
    }

    // 4. Update status in Supabase if we have a record
    if (supabaseLeadId) {
      try {
        await fetch(`${supabaseUrl}/rest/v1/rank_rent_leads?id=eq.${supabaseLeadId}`, {
          method: 'PATCH',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            status: vudStatus,
            vud_lead_id: vudLeadId,
            api_response: vudRawResponse.substring(0, 1000) // Truncate if too long
          })
        });
      } catch (updateErr) {
        console.error('Supabase update failure:', updateErr);
      }
    }

    // 5. Redirect user to confirmation page
    return new Response(null, {
      status: 302,
      headers: {
        'Location': `/confirmation/?name=${encodeURIComponent(firstname)}&city=${encodeURIComponent(city)}`
      }
    });

  } catch (globalErr) {
    console.error('Global lead function error:', globalErr);
    return new Response(JSON.stringify({ error: "Une erreur interne est survenue." }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
